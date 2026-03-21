const {
  Client,
  ClientLedger,
  Branch,
  Quotation,
  QuotationItem,
  Stock,
  Ledger,
  sequelize
} = require("../../../model/SQL_Model");
const pdf = require("html-pdf");
const PDFDocument = require("pdfkit");
const puppeteer = require("puppeteer");
const { generateEwayBill } = require("../../../utils/ewayService");
const { quotationHTML } = require("../../../utils/qt");
const { invoiceHTML } = require("../../../utils/invoice");
const { generateIRN } = require("../../../utils/taxproService");
const { generateEinvoicePayload } = require("../../../utils/einvoicePayload");
const getOrCreateClient = async (data, t) => {

  let client = await Client.findOne({
    where: {
      phone: data.phone,
      branch_id: data.branch_id
    },
    transaction: t
  });

  if (client) return client;

  const last = await Client.findOne({
    where: { branch_id: data.branch_id },
    order: [["createdAt", "DESC"]],
    transaction: t
  });

  let next = 1;

  if (last?.client_code) {
    next =
      Number(last.client_code.split("-")[1]) + 1;
  }

  const code =
    `BR${data.branch_id}-${String(next).padStart(4, "0")}`;

  client = await Client.create({
    name: data.name,
    phone: data.phone,
    email: data.email,
    address: data.address,
    branch_id: data.branch_id,
    gst_number: data.gst_number,
    client_code: code
  }, { transaction: t });

  return client;
};
exports.createClient = async (req, res) => {

  const t = await sequelize.transaction();

  try {

    const {
      client_type,
      company_name,
      contact_person,
      phone,
      email,
      address,
      city,
      country
    } = req.body;

    const branch_id = req.user.branch_id;

    if (!company_name) {
      await t.rollback();
      return res.status(400).json({
        error: "Company name required"
      });
    }

    // =========================
    // CLIENT CODE GENERATION
    // =========================

    const lastClient = await Client.findOne({
      where: { branch_id },
      order: [["createdAt", "DESC"]],
      transaction: t,
      lock: t.LOCK.UPDATE
    });

    let nextNumber = 1;

    if (lastClient?.client_code) {
      const lastNumber =
        parseInt(lastClient.client_code.split("-")[1]);
      nextNumber = lastNumber + 1;
    }

    const client_code =
      `BR${branch_id}-${String(nextNumber).padStart(4, "0")}`;

    // =========================
    // CREATE CLIENT
    // =========================

    const client = await Client.create({

      client_type,
      company_name,
      contact_person,
      phone,
      email,
      address,
      city,
      country,

      branch_id,
      client_code

    }, { transaction: t });

    await t.commit();

    res.status(201).json({
      message: "Client created successfully",
      client
    });

  }
  catch (err) {

    await t.rollback();

    res.status(500).json({
      error: err.message
    });

  }

};

exports.listClients = async (req, res) => {
  try {
    const { search = "", branch_id } = req.query;

    const where = {};
    if (branch_id) where.branch_id = branch_id;

    if (search) {
      where[Op.or] = [
        { name: { [Op.iLike]: `%${search}%` } },
        { phone: { [Op.iLike]: `%${search}%` } },
        { email: { [Op.iLike]: `%${search}%` } }
      ];
    }

    const clients = await Client.findAll({
      where,
      order: [["createdAt", "DESC"]]
    });

    res.json({ total: clients.length, clients });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.createQuotation = async (req, res) => {
  const t = await sequelize.transaction();

  try {
    const { client, products, gst_percent = 0, valid_till } = req.body;

    const branch_id = req.user.branch_id;

    if (!products || products.length === 0) {
      if (!t.finished) await t.rollback();
      return res.status(400).json({ error: "Products are required" });
    }

    // ================= CLIENT =================
    const clientData = await getOrCreateClient({ ...client, branch_id }, t);

    // ================= STOCK VALIDATION =================
    for (const p of products) {
      const stock = await Stock.findOne({
        where: { item: p.product_name, branch_id },
        transaction: t,
      });

      if (!stock) {
        if (!t.finished) await t.rollback();
        return res.status(400).json({ error: `Stock not found for ${p.product_name}` });
      }

      if (stock.quantity < p.quantity) {
        if (!t.finished) await t.rollback();
        return res.status(400).json({ error: `Not enough stock for ${p.product_name}` });
      }
    }

    // ================= QUOTATION NO =================
    const last = await Quotation.findOne({
      where: { branch_id },
      order: [["createdAt", "DESC"]],
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    let next = 1;
    if (last?.quotation_no) {
      const parts = last.quotation_no.split("-");
      next = Number(parts[2]) + 1;
    }

    const quotation_no = `QT-${branch_id}-${String(next).padStart(4, "0")}`;

    // ================= TOTAL =================
    let subtotal = 0;
    for (const p of products) {
      subtotal += p.quantity * p.unit_price;
    }

    const gst_amount = (subtotal * gst_percent) / 100;
    const grand_total = subtotal + gst_amount;

    // ================= CREATE QUOTATION =================
    const quotation = await Quotation.create(
      {
        quotation_no,
        client_id: clientData.id,
        branch_id,
        total_amount: grand_total,
        gst_amount,
        valid_till: valid_till || null,
        status: "pending",
      },
      { transaction: t }
    );

    // ================= ITEMS =================
    for (const p of products) {
      const itemTotal = p.quantity * p.unit_price;

      const cgst = (itemTotal * gst_percent) / 200;
      const sgst = (itemTotal * gst_percent) / 200;

      await QuotationItem.create(
        {
          quotation_id: quotation.id,
          product_name: p.product_name,
          quantity: p.quantity,
          unit_price: p.unit_price,
          unit: p.unit || "",
          hsn: p.hsn || "",
          specifications: p.specifications || "",
          cgst,
          sgst,
          subtotal: itemTotal,
          amount: itemTotal + cgst + sgst,
        },
        { transaction: t }
      );
    }

    await t.commit();

    // ================= FETCH DATA =================
    const branch = await Branch.findByPk(branch_id);

    const items = await QuotationItem.findAll({
      where: { quotation_id: quotation.id },
    });

    // ================= PDF WITH PDFKIT =================
    const doc = new PDFDocument({ margin: 30 });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename=${quotation_no}.pdf`
    );

    doc.pipe(res);

    // HEADER
    doc.fontSize(16).text(branch.name || "", { align: "center" });
    doc.fontSize(10).text(branch.address || "", { align: "center" });
    doc.text(`GST: ${branch.gst || ""}`, { align: "center" });
    doc.moveDown();

    doc.fontSize(14).text("QUOTATION", { align: "center" });
    doc.moveDown();

    // DETAILS
    doc.fontSize(10);
    doc.text(`Quotation No: ${quotation.quotation_no}`);
    doc.text(`Date: ${new Date(quotation.createdAt).toDateString()}`);
    doc.text(`Status: ${quotation.status}`);
    doc.moveDown();

    doc.text(`Billing To:`);
    doc.text(`${clientData.name}`);
    doc.text(`${clientData.address}`);
    doc.moveDown();

    // TABLE HEADER
    doc.text("No  Item  Qty  Rate  Total");
    doc.moveDown();

    // ITEMS
    items.forEach((it, i) => {
      doc.text(
        `${i + 1}  ${it.product_name}  ${it.quantity}  ${it.unit_price}  ${it.amount}`
      );
    });

    doc.moveDown(2);

    // TOTAL
    doc.text(`Subtotal: ${subtotal}`);
    doc.text(`GST: ${gst_amount}`);
    doc.text(`Grand Total: ${grand_total}`);

    doc.end();

  } catch (err) {
    try {
      if (!t.finished) await t.rollback();
    } catch (rollbackErr) {
      console.error("Rollback failed:", rollbackErr);
    }

    console.error(err);
    return res.status(500).json({
      message: "Something went wrong!",
      error: err.message,
    });
  }
};
exports.convertQuotationToInvoice = async (req, res) => {

  let t;

  try {

    const { id } = req.params;

    t = await sequelize.transaction();

    const quotation = await Quotation.findByPk(id, {
      transaction: t,
      lock: t.LOCK.UPDATE
    });

    if (!quotation) {
      await t.rollback();
      return res.status(404).json({ error: "Quotation not found" });
    }

    if (quotation.status !== "approved") {
      await t.rollback();
      return res.status(400).json({ error: "Quotation not approved" });
    }

    const items = await QuotationItem.findAll({
      where: { quotation_id: id },
      transaction: t
    });

    if (!items.length) {
      await t.rollback();
      return res.status(400).json({ error: "No quotation items found" });
    }

    const client = await Client.findByPk(quotation.client_id, { transaction: t });
    const branch = await Branch.findByPk(quotation.branch_id, { transaction: t });

    if (!client) {
      await t.rollback();
      return res.status(404).json({ error: "Client not found" });
    }

    if (!branch) {
      await t.rollback();
      return res.status(404).json({ error: "Branch not found" });
    }

   

    const invoice_no = "INV-" + quotation.quotation_no;

    const invoice = {
      invoice_no,
      quotation_no: quotation.quotation_no,
      total_amount: quotation.total_amount,
      gst_amount: quotation.gst_amount,
      status: "created",
      createdAt: new Date(),

      // Eway
      eway_bill_no: null,
      eway_bill_date: null,

      // TaxPro
      irn: null,
      ack_no: null,
      ack_date: null,
      qr_code: null
    };



    for (const it of items) {

      const stock = await Stock.findOne({
        where: {
          name: it.product_name,
          branch_id: quotation.branch_id
        },
        transaction: t,
        lock: t.LOCK.UPDATE
      });

      if (!stock) {
        await t.rollback();
        return res.status(400).json({ error: `Stock not found ${it.product_name}` });
      }

      if (Number(stock.quantity) < Number(it.quantity)) {
        await t.rollback();
        return res.status(400).json({ error: `Not enough stock ${it.product_name}` });
      }

      stock.quantity = Number(stock.quantity) - Number(it.quantity);

      await stock.save({ transaction: t });

      await Ledger.create({
        branch_id: quotation.branch_id,
        stock_id: stock.id,
        type: "SALE",
        quantity: Number(it.quantity),
        rate: Number(it.unit_price),
        total: Number(it.subtotal),
        reference_no: invoice_no
      }, { transaction: t });

    }

 

    await ClientLedger.create({
      client_id: quotation.client_id,
      branch_id: quotation.branch_id,
      type: "SALE",
      amount: Number(quotation.total_amount),
      invoice_no,
      remark: "Invoice"
    }, { transaction: t });

    quotation.status = "invoiced";

    await quotation.save({ transaction: t });

    await t.commit();


try {

  const payload = generateEinvoicePayload({
    invoice,
    client,
    branch,
    items
  });

  const taxResponse = await generateIRN(payload);

  // IRN Details
  invoice.irn = taxResponse?.Irn || null;
  invoice.ack_no = taxResponse?.AckNo || null;
  invoice.ack_date = taxResponse?.AckDt || null;
  invoice.qr_code = taxResponse?.SignedQRCode || null;

  // Eway Details (TaxPro response)
  invoice.eway_bill_no =
    taxResponse?.EwbNo ||
    taxResponse?.ewayBillNo ||
    null;

  invoice.eway_bill_date =
    taxResponse?.EwbDt ||
    taxResponse?.ewayBillDate ||
    null;

} catch (err) {

  console.log("TaxPro generation failed:", err.message);

}


    const html = invoiceHTML({
      branch,
      invoice,
      client,
      items
    });

   

    const pdf = await generatePdfFromHtml(html);

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename=${invoice_no}.pdf`
    });

    return res.send(pdf);

  } catch (err) {

    if (t) await t.rollback();

    return res.status(500).json({
      error: err.message
    });

  }

};
exports.approveQuotation = async (req, res) => {
  try {
    const { id } = req.params;

    // 1️⃣ Fetch quotation by ID
    const quotation = await Quotation.findByPk(id);

    if (!quotation) {
      return res.status(404).json({ error: "Quotation not found" });
    }

    // 2️⃣ Optional: Only certain roles can approve
    const allowedRoles = ["super_admin", "super_sales_manager"];
    if (!allowedRoles.includes(req.user.role)) {
      return res
        .status(403)
        .json({ message: "Access denied: Insufficient role" });
    }

    // 3️⃣ Check if already approved
    if (quotation.status === "approved") {
      return res
        .status(400)
        .json({ message: "Quotation is already approved" });
    }

    // 4️⃣ Update status
    quotation.status = "approved";
    await quotation.save();

    // 5️⃣ Respond with updated data
    res.status(200).json({
      message: "Quotation approved successfully",
      quotation,
    });

  } catch (err) {
    console.error("APPROVE QUOTATION ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
};
exports.generateQuotationPDF = async (req, res) => {
  try {
    const { quotation_id } = req.params;

    const quotation = await Quotation.findByPk(quotation_id, {
      include: [Client, Branch],
    });

    if (!quotation) {
      return res.status(404).json({ error: "Quotation not found" });
    }

    const items = await QuotationItem.findAll({
      where: { quotation_id },
    });

    const client = quotation.Client;
    const branch = quotation.Branch;

    const doc = new PDFDocument({ margin: 30 });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename=${quotation.quotation_no}.pdf`
    );

    doc.pipe(res);

    // ================= HEADER =================
    doc.fontSize(16).text(branch.name || "", { align: "center" });
    doc.fontSize(10).text(branch.address || "", { align: "center" });
    doc.text(`GST: ${branch.gst || ""}`, { align: "center" });
    doc.moveDown();

    doc.fontSize(14).text("QUOTATION", { align: "center" });
    doc.moveDown();

    // ================= DETAILS =================
    doc.fontSize(10);
    doc.text(`Quotation No: ${quotation.quotation_no}`);
    doc.text(`Date: ${new Date(quotation.createdAt).toDateString()}`);
    doc.text(`Status: ${quotation.status}`);
    doc.moveDown();

    doc.text(`Billing To:`);
    doc.text(`${client.name}`);
    doc.text(`${client.address}`);
    doc.moveDown();

    // ================= TABLE HEADER =================
    doc.fontSize(9);
    doc.text("#", 30);
    doc.text("Item", 60);
    doc.text("Qty", 200);
    doc.text("Rate", 240);
    doc.text("Taxable", 300);
    doc.text("Total", 380);

    doc.moveDown();

    // ================= ITEMS =================
    let y = doc.y;

    items.forEach((it, i) => {
      doc.text(i + 1, 30, y);
      doc.text(it.product_name, 60, y);
      doc.text(it.quantity, 200, y);
      doc.text(Number(it.unit_price).toFixed(2), 240, y);
      doc.text(Number(it.subtotal).toFixed(2), 300, y);
      doc.text(Number(it.amount).toFixed(2), 380, y);

      y += 20;
    });

    doc.moveDown(2);

    // ================= TOTAL =================
    doc.fontSize(10);
    doc.text(`Subtotal: ${quotation.total_amount - quotation.gst_amount}`);
    doc.text(`GST: ${quotation.gst_amount}`);
    doc.text(`Grand Total: ${quotation.total_amount}`);

    doc.moveDown();
    doc.text("Computer generated quotation.");

    doc.end();

  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: err.message,
    });
  }
};
exports.createSaleEntry = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { client_id, invoice_no, amount, remark } = req.body;

    if (!client_id || !amount) {
      return res.status(400).json({ error: "client_id and amount required" });
    }

    const client = await Client.findByPk(client_id);
    if (!client) return res.status(404).json({ error: "Client not found" });

    // Branch rule:
    // Sales manager normally works for his branch
    const branch_id = req.user.branch_id || client.branch_id;

    const entry = await ClientLedger.create({
      client_id,
      branch_id,
      type: "SALE",
      invoice_no: invoice_no || null,
      amount: Number(amount),
      remark: remark || "Sale"
    }, { transaction: t });

    await t.commit();

    res.status(201).json({ message: "Sale added in ledger", entry });

  } catch (err) {
    await t.rollback();
    res.status(500).json({ error: err.message });
  }
};



exports.addClientPayment = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { client_id, amount, remark } = req.body;

    if (!client_id || !amount) {
      return res.status(400).json({ error: "client_id and amount required" });
    }

    const client = await Client.findByPk(client_id);
    if (!client) return res.status(404).json({ error: "Client not found" });

    const branch_id = req.user.branch_id || client.branch_id;

    const entry = await ClientLedger.create({
      client_id,
      branch_id,
      type: "PAYMENT",
      amount: Number(amount),
      remark: remark || "Payment received"
    }, { transaction: t });

    await t.commit();

    res.status(201).json({ message: "Payment added in ledger", entry });

  } catch (err) {
    await t.rollback();
    res.status(500).json({ error: err.message });
  }
};


exports.getClientLedger = async (req, res) => {
  try {

    const clients = await Client.findAll({
      attributes: [
        "id",
        "name",
        "phone",
        "email",
        "client_code",
        [
          sequelize.literal(`
            COALESCE(SUM(CASE WHEN ledger.type='SALE' THEN ledger.amount ELSE 0 END),0)
          `),
          "revenue"
        ],
        [
          sequelize.literal(`
            COALESCE(SUM(CASE WHEN ledger.type='PAYMENT' THEN ledger.amount ELSE 0 END),0)
          `),
          "payment"
        ],
        [
          sequelize.literal(`
            COALESCE(SUM(CASE WHEN ledger.type='SALE' THEN ledger.amount ELSE 0 END),0)
            -
            COALESCE(SUM(CASE WHEN ledger.type='PAYMENT' THEN ledger.amount ELSE 0 END),0)
          `),
          "pendingAmount"
        ]
      ],
      include: [
        {
          model: ClientLedger,
          as: "ledger",
          attributes: []
        }
      ],
      group: ["Client.id"]
    });

    res.json({
      success: true,
      totalClients: clients.length,
      clients
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
};

exports.getClientLedgerDetails = async (req, res) => {
  try {

    const { clientId } = req.params;

    const ledger = await ClientLedger.findAll({
      where: { client_id: clientId },
      attributes: [
        "id",
        "invoice_no",
        "type",
        "amount",
        "remark",
        "createdAt"
      ],
      include: [
        {
          model: Client,
          as: "client",
          attributes: ["id", "name"]
        }
      ],
      order: [["createdAt", "DESC"]]
    });

    res.json({
      success: true,
      totalEntries: ledger.length,
      ledger
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
};


exports.listQuotations = async (req, res) => {
  try {

    const branchId = req.user?.branch_id; // agar branch based access hai

    const quotations = await Quotation.findAll({
      where: branchId ? { branch_id: branchId } : {},

      attributes: [
        "id",
        "quotation_no",
        "client_id",
        "branch_id",
        "total_amount",
        "gst_amount",
        "valid_till",
        "status",
        "createdAt"
      ],

      include: [
        {
          model: Client,
          as: "client",
          attributes: ["id", "name", "phone", "email"]
        },
        {
          model: Branch,
          as: "branch",
          attributes: ["id", "name", "location"]
        },
        {
          model: QuotationItem,
          as: "items",
          attributes: [
            "id",
            "product_name",
            "quantity",
            "unit_price",
            "cgst",
            "sgst",
            "amount"
          ]
        }
      ],

      order: [["createdAt", "DESC"]]
    });

    res.json({
      total: quotations.length,
      quotations
    });

  } catch (err) {

    res.status(500).json({
      success: false,
      error: err.message
    });

  }
};

exports.reportandanalysis = async (req, res) => {
  try {

    const branchId = req.user?.branch_id || null;

    // ===============================
    // COMMON WHERE
    // ===============================
    const whereClause = branchId ? `WHERE branch_id = ${branchId}` : "";

    // ===============================
    // 1. CARDS
    // ===============================
    const cards = await sequelize.query(`
      SELECT 
        COALESCE(SUM(total_amount),0) AS revenue,
        COALESCE(AVG(total_amount),0) AS avgOrderValue,
        COUNT(*) AS totalOrders,
        COUNT(DISTINCT client_id) AS activeClients
      FROM quotations
      ${whereClause}
    `);

    // ===============================
    // 2. REVENUE & ORDERS TREND
    // ===============================
    const revenueTrend = await sequelize.query(`
      SELECT 
        TO_CHAR("createdAt",'Mon') AS month,
        SUM(total_amount) AS revenue,
        COUNT(*) AS orders
      FROM quotations
      ${whereClause}
      GROUP BY month, DATE_TRUNC('month',"createdAt")
      ORDER BY DATE_TRUNC('month',"createdAt")
    `);

    // ===============================
    // 3. CATEGORY DISTRIBUTION
    // ===============================
    const categoryDistribution = await sequelize.query(`
      SELECT 
        COALESCE(qi.product_name, 'Others') AS name,
        SUM(qi.amount) AS value
      FROM quotation_items qi
      JOIN quotations q ON q.id = qi.quotation_id
      ${branchId ? `WHERE q.branch_id = ${branchId}` : ""}
      GROUP BY qi.product_name
    `);

    // ===============================
    // 4. WEEKLY ACTIVITY (FIXED ENUM)
    // ===============================
    const weeklyActivity = await sequelize.query(`
      SELECT 
        TO_CHAR("createdAt",'Dy') AS day,

        COUNT(*) FILTER (WHERE status='pending') AS quotations,
        COUNT(*) FILTER (WHERE status='approved') AS approved,
        COUNT(*) FILTER (WHERE status='invoiced') AS invoices

      FROM quotations
      WHERE "createdAt" >= NOW() - INTERVAL '7 days'
      ${branchId ? `AND branch_id = ${branchId}` : ""}
      GROUP BY day
      ORDER BY MIN("createdAt")
    `);

    // ===============================
    // 5. PROFIT ANALYSIS
    // ===============================
    const profitAnalysis = await sequelize.query(`
      SELECT 
        TO_CHAR("createdAt",'Mon') AS month,
        SUM(total_amount * 0.2) AS profit
      FROM quotations
      ${whereClause}
      GROUP BY month, DATE_TRUNC('month',"createdAt")
      ORDER BY DATE_TRUNC('month',"createdAt")
    `);

    // ===============================
    // 6. TOP PRODUCTS
    // ===============================
    const topProducts = await sequelize.query(`
      SELECT 
        qi.product_name,
        SUM(qi.quantity) AS sales,
        SUM(qi.amount) AS revenue
      FROM quotation_items qi
      JOIN quotations q ON q.id = qi.quotation_id
      ${branchId ? `WHERE q.branch_id = ${branchId}` : ""}
      GROUP BY qi.product_name
      ORDER BY sales DESC
      LIMIT 5
    `);

    // ===============================
    // 7. RECENT TRANSACTIONS
    // ===============================
    const recentTransactions = await sequelize.query(`
      SELECT 
        q.quotation_no AS invoice,
        c.name AS client,
        q.total_amount AS amount,
        q.status
      FROM quotations q
      LEFT JOIN clients c ON c.id = q.client_id
      ${branchId ? `WHERE q.branch_id = ${branchId}` : ""}
      ORDER BY q."createdAt" DESC
      LIMIT 5
    `);

    // ===============================
    // 8. INVENTORY STATUS (FIXED ENUM)
    // ===============================
    const inventoryStatus = await sequelize.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status='GOOD') AS "inStock",
        COUNT(*) FILTER (WHERE status='REPAIRABLE') AS "lowStock",
        COUNT(*) FILTER (WHERE status='DAMAGED') AS "outOfStock"
      FROM stocks
      ${whereClause}
    `);

    // ===============================
    // 9. CLIENT BREAKDOWN
    // ===============================
    const clientBreakdown = await sequelize.query(`
      SELECT 
        COUNT(*) FILTER (WHERE "createdAt" >= NOW() - INTERVAL '30 days') AS "newClients",
        COUNT(*) FILTER (WHERE "createdAt" < NOW() - INTERVAL '30 days') AS "returningClients"
      FROM clients
      ${whereClause}
    `);

    // ===============================
    // 10. QUICK STATS (FIXED ENUM)
    // ===============================
    const quickStats = await sequelize.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status='approved') AS "approvedQuotations",
        COUNT(*) FILTER (WHERE status='invoiced') AS "invoicesGenerated",
        COUNT(*) FILTER (WHERE status='pending') AS "pendingApprovals"
      FROM quotations
      ${whereClause}
    `);

    // ===============================
    // FINAL RESPONSE
    // ===============================
    res.json({
      success: true,

      cards: cards[0][0],
      revenueTrend: revenueTrend[0],
      categoryDistribution: categoryDistribution[0],
      weeklyActivity: weeklyActivity[0],
      profitAnalysis: profitAnalysis[0],
      topProducts: topProducts[0],
      recentTransactions: recentTransactions[0],
      inventoryStatus: inventoryStatus[0][0],
      clientBreakdown: clientBreakdown[0][0],
      quickStats: quickStats[0][0]

    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
};

//top screen work on this 
exports.getAdvancedSalesAnalytics = async (req, res) => {
  try {

    const branchId = req.user?.branch_id || null;
    const whereClause = branchId ? `WHERE branch_id = ${branchId}` : "";

    // ===============================
    // 1. QUICK ACTION CARDS
    // ===============================
    const quickCards = await sequelize.query(`
      SELECT 
        COALESCE(SUM(total_amount),0) AS todaySale,
        COUNT(*) AS totalOrders,
        COUNT(*) FILTER (WHERE status='pending') AS pendingQuotation,
        COUNT(*) FILTER (WHERE status='invoiced') AS readyToDispatch
      FROM quotations
      WHERE DATE("createdAt") = CURRENT_DATE
      ${branchId ? `AND branch_id = ${branchId}` : ""}
    `);

    // ===============================
    // 2. SALES ANALYTICS (ONLINE vs OFFLINE)
    // ===============================
    const salesAnalytics = await sequelize.query(`
      SELECT 
        TO_CHAR("createdAt",'Mon') AS month,

        SUM(CASE WHEN reference_no IS NOT NULL THEN total_amount ELSE 0 END) AS onlineSales,
        SUM(CASE WHEN reference_no IS NULL THEN total_amount ELSE 0 END) AS offlineSales

      FROM quotations
      ${whereClause}
      GROUP BY month, DATE_TRUNC('month',"createdAt")
      ORDER BY DATE_TRUNC('month',"createdAt")
    `);

    // ===============================
    // 3. QUOTATION STATUS (DONUT)
    // ===============================
    const quotationStatus = await sequelize.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status='pending') AS pending,
        COUNT(*) FILTER (WHERE status='approved') AS approved,
        COUNT(*) FILTER (WHERE status='rejected') AS rejected,
        COUNT(*) FILTER (WHERE status='invoiced') AS invoiced,
        COALESCE(SUM(total_amount),0) AS totalValue
      FROM quotations
      ${whereClause}
    `);

    // ===============================
    // 4. SALES BY CATEGORY (UNITS SOLD)
    // ===============================
    const categorySales = await sequelize.query(`
      SELECT 
        qi.product_name AS category,
        SUM(qi.quantity) AS units,
        SUM(qi.amount) AS revenue
      FROM quotation_items qi
      JOIN quotations q ON q.id = qi.quotation_id
      ${branchId ? `WHERE q.branch_id = ${branchId}` : ""}
      GROUP BY qi.product_name
      ORDER BY units DESC
    `);

    // ===============================
    // 5. RECENT ACTIVITY
    // ===============================
    const recentActivity = await sequelize.query(`
      SELECT 
        q.quotation_no,
        c.name AS client,
        q.total_amount,
        q.status,
        q."createdAt"
      FROM quotations q
      LEFT JOIN clients c ON c.id = q.client_id
      ${branchId ? `WHERE q.branch_id = ${branchId}` : ""}
      ORDER BY q."createdAt" DESC
      LIMIT 10
    `);

    // ===============================
    // FINAL RESPONSE
    // ===============================
    res.json({
      success: true,

      quickAction: {
        todaySale: quickCards[0][0].todaysale,
        totalSale: quickCards[0][0].totalorders,
        pendingQuotation: quickCards[0][0].pendingquotation,
        readyToDispatch: quickCards[0][0].readytodispatch
      },

      salesAnalytics: salesAnalytics[0],

      quotationStatus: quotationStatus[0][0],

      categorySales: categorySales[0],

      recentActivity: recentActivity[0]

    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
};

exports.getClientLedgerSummary = async (req, res) => {
  try {

    const branchId = req.user?.branch_id || null;

    const data = await sequelize.query(`
      SELECT 
        c.id AS "clientId",
        c.name AS "companyName",
        c.email,
        c.phone,
        COALESCE(c.gst_number, 'N/A') AS "gstNumber",

        COUNT(q.id) AS "totalEntries",

        COALESCE(SUM(q.total_amount),0) AS "totalAmount",

        COALESCE(SUM(
          CASE 
            WHEN q.status = 'pending' THEN q.total_amount 
            ELSE 0 
          END
        ),0) AS "pendingAmount",

        COALESCE(SUM(
          CASE 
            WHEN q.status = 'invoiced' THEN q.total_amount 
            ELSE 0 
          END
        ),0) AS "revenue"

      FROM clients c

      LEFT JOIN quotations q 
      ON q.client_id = c.id

      ${branchId ? `WHERE c.branch_id = ${branchId}` : ""}

      GROUP BY c.id

      ORDER BY "totalAmount" DESC
    `);

    res.json({
      success: true,
      clients: data[0]
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
};

// exports.getClientLedgerDetails = async (req, res) => {
//   try {

//     const { clientId } = req.params;
//     const branchId = req.user?.branch_id || null;

//     const data = await sequelize.query(`
//       SELECT 
//         q.id AS "entryId",
//         q.quotation_no AS "transactionId",
//         c.name AS "client",
//         TO_CHAR(q."createdAt", 'DD/MM/YYYY, HH24:MI:SS') AS "dateTime",

//         -- TOTAL AMOUNT
//         COALESCE(q.total_amount,0) AS "amount",

//         -- RECEIVED (invoiced means received)
//         COALESCE(
//           CASE 
//             WHEN q.status = 'invoiced' THEN q.total_amount
//             ELSE 0
//           END
//         ,0) AS "receivedAmount",

//         -- PENDING
//         COALESCE(
//           CASE 
//             WHEN q.status != 'invoiced' THEN q.total_amount
//             ELSE 0
//           END
//         ,0) AS "pendingAmount"

//       FROM quotations q

//       LEFT JOIN clients c 
//       ON c.id = q.client_id

//       WHERE q.client_id = :clientId
//       ${branchId ? `AND q.branch_id = ${branchId}` : ""}

//       ORDER BY q."createdAt" DESC
//     `, {
//       replacements: { clientId }
//     });

//     res.json({
//       success: true,
//       totalEntries: data[0].length,
//       ledger: data[0]
//     });

//   } catch (err) {
//     console.error(err);
//     res.status(500).json({
//       success: false,
//       error: err.message
//     });
//   }
// };

exports.getClientLedgerDetails = async (req, res) => {
  try {

    const { clientId } = req.params;
    const branchId = req.user?.branch_id || null;

    const data = await sequelize.query(`
      SELECT 
        q.id AS "entryId",
        q.quotation_no AS "transactionId",
        c.name AS "client",
        TO_CHAR(q."createdAt", 'DD/MM/YYYY, HH24:MI:SS') AS "dateTime",

        -- TOTAL AMOUNT
        COALESCE(q.total_amount,0) AS "amount",

        -- RECEIVED (invoiced means received)
        COALESCE(
          CASE 
            WHEN q.status = 'invoiced' THEN q.total_amount
            ELSE 0
          END
        ,0) AS "receivedAmount",

        -- PENDING
        COALESCE(
          CASE 
            WHEN q.status != 'invoiced' THEN q.total_amount
            ELSE 0
          END
        ,0) AS "pendingAmount"

      FROM quotations q

      LEFT JOIN clients c 
      ON c.id = q.client_id

      WHERE q.client_id = :clientId
      ${branchId ? `AND q.branch_id = ${branchId}` : ""}

      ORDER BY q."createdAt" DESC
    `, {
      replacements: { clientId }
    });

    res.json({
      success: true,
      totalEntries: data[0].length,
      ledger: data[0]
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
};


exports.getInvoiceDashboard = async (req, res) => {
  try {

    const branchId = req.user?.branch_id || null;
    const whereClause = branchId ? `WHERE branch_id = ${branchId}` : "";

    // ===============================
    // 1. TOP CARDS
    // ===============================
    const stats = await sequelize.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status='invoiced') AS "totalInvoice",

        COUNT(*) FILTER (
          WHERE status='pending'
          AND "createdAt" >= NOW() - INTERVAL '7 days'
        ) AS "pendingInvoice",

        COUNT(*) FILTER (
          WHERE status='invoiced'
          AND DATE("createdAt") = CURRENT_DATE
        ) AS "todayInvoice",

        COUNT(*) FILTER (WHERE status='rejected') AS "rejectedInvoice"

      FROM quotations
      ${whereClause}
    `);

    // ===============================
    // 2. INVOICE LIST
    // ===============================
    const invoices = await sequelize.query(`
      SELECT 
        q.id,
        q.quotation_no AS "invoiceNo",
        c.name AS client,
        q.total_amount AS amount,
        q.status,

        TO_CHAR(q."createdAt", 'DD/MM/YYYY, HH24:MI') AS date,

        q.reference_no AS "quotationRef"

      FROM quotations q

      LEFT JOIN clients c 
      ON c.id = q.client_id

      ${branchId ? `WHERE q.branch_id = ${branchId}` : ""}

      ORDER BY q."createdAt" DESC
      LIMIT 20
    `);

    // ===============================
    // FINAL RESPONSE
    // ===============================
    res.json({
      success: true,

      stats: stats[0][0],

      invoices: invoices[0]

    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
};