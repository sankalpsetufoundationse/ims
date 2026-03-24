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
const { QueryTypes } = require("sequelize")
const { Op } = require("sequelize");
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

    const user = req.user;

    // role name nikal
    const roleName = user.role?.name || user.role;

    let where = {};

    // =========================
    // 🔐 ROLE BASED FILTER
    // =========================

    // 👑 SUPER SALES MANAGER → ALL DATA
    if (roleName !== "super_sales_manager") {
      where.branch_id = user.branch_id;
    }

    // optional branch filter (only super)
    if (branch_id && roleName === "super_sales_manager") {
      where.branch_id = branch_id;
    }

    // =========================
    // 🔍 SEARCH
    // =========================
    if (search) {
      where[Op.or] = [
        { name: { [Op.iLike]: `%${search}%` } },
        { phone: { [Op.iLike]: `%${search}%` } },
        { email: { [Op.iLike]: `%${search}%` } },
        { address: { [Op.iLike]: `%${search}%` } }
      ];
    }

    // =========================
    // 📦 FETCH DATA
    // =========================
    const clients = await Client.findAll({
      where,
      include: [
        {
          model: Branch,
          as: "branch",
          attributes: ["id", "name"]
        }
      ],
      order: [["createdAt", "DESC"]]
    });

    // =========================
    // 🧠 RESPONSE FORMAT
    // =========================
    const formatted = clients.map((c) => ({
      id: c.id,
      client_code: c.client_code,
      name: c.name,
      phone: c.phone,
      email: c.email,
      address: c.address,

      branch_id: c.branch_id,
      branch_name: c.branch?.name || null,

      created_at: c.createdAt
    }));

    res.json({
      total: formatted.length,
      clients: formatted
    });

  } catch (err) {
    console.error(err);
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

    const role = req.user?.role?.name || req.user?.role || "";
    const userBranches = Array.isArray(req.user?.branches) && req.user.branches.length
      ? req.user.branches.map(Number).filter((b) => !isNaN(b))
      : req.user?.branch_id
      ? [Number(req.user.branch_id)].filter((b) => !isNaN(b))
      : [];

    // 1. fetch quotation with branch
    const quotation = await Quotation.findByPk(id);

    if (!quotation) {
      return res.status(404).json({
        success: false,
        error: "Quotation not found"
      });
    }

    // 2. allowed roles
    const allowedRoles = [
      "super_admin",
      "super_sales_manager",
      "super_sales_admin",
      "sales_manager"
    ];

    if (!allowedRoles.includes(role)) {
      return res.status(403).json({
        success: false,
        message: "Access denied: Insufficient role"
      });
    }

    // 3. sales_manager can approve only own branch quotation
    if (role === "sales_manager") {
      if (!userBranches.length) {
        return res.status(403).json({
          success: false,
          message: "No branch access"
        });
      }

      if (!userBranches.includes(Number(quotation.branch_id))) {
        return res.status(403).json({
          success: false,
          message: "Access denied: You can approve only your branch quotations"
        });
      }
    }

    // 4. already approved
    if (quotation.status === "approved") {
      return res.status(400).json({
        success: false,
        message: "Quotation is already approved"
      });
    }

    // optional: prevent rejected/invoiced approval
    if (quotation.status === "invoiced") {
      return res.status(400).json({
        success: false,
        message: "Invoiced quotation cannot be approved again"
      });
    }

    quotation.status = "approved";
    await quotation.save();

    return res.status(200).json({
      success: true,
      message: "Quotation approved successfully",
      quotation
    });
  } catch (err) {
    console.error("APPROVE QUOTATION ERROR:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Server error"
    });
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
    const user = req.user;
    const role = user.role?.name || user.role || "";

    // super role support
    const isSuperSales =
      role === "super_sales_manager" || role === "super_sales_admin";

    // normalize branch access
    const userBranches = Array.isArray(user.branches) && user.branches.length
      ? user.branches.map(Number).filter((id) => !isNaN(id))
      : user.branch_id
      ? [Number(user.branch_id)].filter((id) => !isNaN(id))
      : [];

    let where = {};

    // =========================
    // QUERY PARAM SANITIZE
    // =========================
    const rawBranchFilter = req.query.branch_id;
    const normalizedBranchFilter =
      rawBranchFilter &&
      String(rawBranchFilter).trim() !== "" &&
      String(rawBranchFilter).trim().toUpperCase() !== "ALL"
        ? Number(rawBranchFilter)
        : null;

    // =========================
    // ROLE BASED FILTER
    // =========================
    if (isSuperSales) {
      // super sales can see all branches
      // and can optionally filter one branch
      if (normalizedBranchFilter !== null) {
        if (isNaN(normalizedBranchFilter)) {
          return res.status(400).json({
            success: false,
            error: "Invalid branch_id. Use numeric branch_id or ALL"
          });
        }

        where.branch_id = normalizedBranchFilter;
      }
    } else {
      // normal sales / branch user -> only own branch
      if (!userBranches.length) {
        return res.status(403).json({
          success: false,
          error: "No branch access"
        });
      }

      where.branch_id = {
        [Op.in]: userBranches
      };
    }

    // =========================
    // FETCH DATA
    // =========================
    const quotations = await Quotation.findAll({
      where,
      attributes: [
        "id",
        "quotation_no",
        "client_id",
        "branch_id",
        "total_amount",
        "gst_amount",
        "valid_till",
        "reference_no",
        "status",
        "createdAt"
      ],
      include: [
        {
          model: Client,
          as: "client",
          attributes: ["id", "name", "phone", "email", "address"]
        },
        {
          model: Branch,
          as: "branch",
          attributes: ["id", "name", "location"]
        },
        {
          model: QuotationItem,
          as: "items"
        }
      ],
      order: [["createdAt", "DESC"]]
    });

    // =========================
    // SUPER SALES RESPONSE
    // =========================
    if (isSuperSales) {
      const grouped = {};

      quotations.forEach((q) => {
        const branchId = q.branch_id || 0;
        const branchName = q.branch?.name || "Unknown";
        const branchLocation = q.branch?.location || "Unknown";

        if (!grouped[branchId]) {
          grouped[branchId] = {
            branchId,
            branchName,
            branchLocation,
            total: 0,
            amount: 0,
            pending: 0,
            approved: 0,
            rejected: 0,
            invoiced: 0,
            quotations: []
          };
        }

        const data = grouped[branchId];

        data.total += 1;
        data.amount += Number(q.total_amount || 0);

        if (q.status === "pending") data.pending += 1;
        if (q.status === "approved") data.approved += 1;
        if (q.status === "rejected") data.rejected += 1;
        if (q.status === "invoiced") data.invoiced += 1;

        data.quotations.push(q);
      });

      // overall summary for super sales
      const summary = {
        totalQuotations: quotations.length,
        totalAmount: quotations.reduce(
          (sum, q) => sum + Number(q.total_amount || 0),
          0
        ),
        pending: quotations.filter((q) => q.status === "pending").length,
        approved: quotations.filter((q) => q.status === "approved").length,
        rejected: quotations.filter((q) => q.status === "rejected").length,
        invoiced: quotations.filter((q) => q.status === "invoiced").length
      };

      return res.json({
        success: true,
        role,
        summary,
        total: quotations.length,
        branches: Object.values(grouped)
      });
    }

    // =========================
    // NORMAL BRANCH SALES RESPONSE
    // =========================
    const summary = {
      totalQuotations: quotations.length,
      totalAmount: quotations.reduce(
        (sum, q) => sum + Number(q.total_amount || 0),
        0
      ),
      pending: quotations.filter((q) => q.status === "pending").length,
      approved: quotations.filter((q) => q.status === "approved").length,
      rejected: quotations.filter((q) => q.status === "rejected").length,
      invoiced: quotations.filter((q) => q.status === "invoiced").length
    };

    return res.json({
      success: true,
      role,
      branch_ids: userBranches,
      summary,
      total: quotations.length,
      quotations
    });
  } catch (err) {
    console.error("listQuotations error:", err);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
};
exports.reportandanalysis = async (req, res) => {
  try {

    // ===============================
    // 🔐 ROLE FIX
    // ===============================
    let role = req.user?.role || "";

    if (typeof role === "object") {
      role = role.name;
    }

    const branchId = req.user?.branch_id || null;
    const isSuperSales = role === "super_sales_manager";

    const whereClause = isSuperSales
      ? ""
      : branchId
      ? `WHERE branch_id = ${branchId}`
      : "";

    const branchCondition = isSuperSales
      ? ""
      : branchId
      ? `AND branch_id = ${branchId}`
      : "";

    // ===============================
    // 1. CARDS
    // ===============================
    const cards = await sequelize.query(`
      SELECT 
        branch_id AS "branchId",
        COALESCE(SUM(total_amount),0) AS revenue,
        COALESCE(AVG(total_amount),0) AS "avgOrderValue",
        COUNT(*) AS "totalOrders",
        COUNT(DISTINCT client_id) AS "activeClients"
      FROM quotations
      ${whereClause}
      GROUP BY branch_id
    `);

    // ===============================
    // 2. REVENUE TREND
    // ===============================
    const revenueTrend = await sequelize.query(`
      SELECT 
        branch_id AS "branchId",
        TO_CHAR("createdAt",'Mon') AS month,
        SUM(total_amount) AS revenue,
        COUNT(*) AS orders
      FROM quotations
      ${whereClause}
      GROUP BY branch_id, month, DATE_TRUNC('month',"createdAt")
      ORDER BY branch_id, DATE_TRUNC('month',"createdAt")
    `);

    // ===============================
    // 3. CATEGORY DISTRIBUTION
    // ===============================
    const categoryDistribution = await sequelize.query(`
      SELECT 
        q.branch_id AS "branchId",
        COALESCE(qi.product_name, 'Others') AS name,
        SUM(qi.amount) AS value
      FROM quotation_items qi
      JOIN quotations q ON q.id = qi.quotation_id
      ${isSuperSales ? "" : branchId ? `WHERE q.branch_id = ${branchId}` : ""}
      GROUP BY q.branch_id, qi.product_name
    `);

    // ===============================
    // 4. WEEKLY ACTIVITY
    // ===============================
    const weeklyActivity = await sequelize.query(`
      SELECT 
        branch_id AS "branchId",
        TO_CHAR("createdAt",'Dy') AS day,
        COUNT(*) FILTER (WHERE status='pending') AS quotations,
        COUNT(*) FILTER (WHERE status='approved') AS approved,
        COUNT(*) FILTER (WHERE status='invoiced') AS invoices
      FROM quotations
      WHERE "createdAt" >= NOW() - INTERVAL '7 days'
      ${branchCondition}
      GROUP BY branch_id, day
      ORDER BY branch_id, MIN("createdAt")
    `);

    // ===============================
    // 5. PROFIT ANALYSIS
    // ===============================
    const profitAnalysis = await sequelize.query(`
      SELECT 
        branch_id AS "branchId",
        TO_CHAR("createdAt",'Mon') AS month,
        SUM(total_amount * 0.2) AS profit
      FROM quotations
      ${whereClause}
      GROUP BY branch_id, month, DATE_TRUNC('month',"createdAt")
      ORDER BY branch_id, DATE_TRUNC('month',"createdAt")
    `);

    // ===============================
    // 6. TOP PRODUCTS
    // ===============================
    const topProducts = await sequelize.query(`
      SELECT 
        q.branch_id AS "branchId",
        qi.product_name,
        SUM(qi.quantity) AS sales,
        SUM(qi.amount) AS revenue
      FROM quotation_items qi
      JOIN quotations q ON q.id = qi.quotation_id
      ${isSuperSales ? "" : branchId ? `WHERE q.branch_id = ${branchId}` : ""}
      GROUP BY q.branch_id, qi.product_name
      ORDER BY q.branch_id, sales DESC
    `);

    // ===============================
    // 7. RECENT TRANSACTIONS
    // ===============================
    const recentTransactions = await sequelize.query(`
      SELECT 
        q.branch_id AS "branchId",
        q.quotation_no AS invoice,
        c.name AS client,
        q.total_amount AS amount,
        q.status
      FROM quotations q
      LEFT JOIN clients c ON c.id = q.client_id
      ${isSuperSales ? "" : branchId ? `WHERE q.branch_id = ${branchId}` : ""}
      ORDER BY q.branch_id, q."createdAt" DESC
      LIMIT 20
    `);

    // ===============================
    // 8. INVENTORY STATUS
    // ===============================
    const inventoryStatus = await sequelize.query(`
      SELECT 
        branch_id AS "branchId",
        COUNT(*) FILTER (WHERE status='GOOD') AS "inStock",
        COUNT(*) FILTER (WHERE status='REPAIRABLE') AS "lowStock",
        COUNT(*) FILTER (WHERE status='DAMAGED') AS "outOfStock"
      FROM stocks
      ${whereClause}
      GROUP BY branch_id
    `);

    // ===============================
    // 9. CLIENT BREAKDOWN
    // ===============================
    const clientBreakdown = await sequelize.query(`
      SELECT 
        branch_id AS "branchId",
        COUNT(*) FILTER (WHERE "createdAt" >= NOW() - INTERVAL '30 days') AS "newClients",
        COUNT(*) FILTER (WHERE "createdAt" < NOW() - INTERVAL '30 days') AS "returningClients"
      FROM clients
      ${whereClause}
      GROUP BY branch_id
    `);

    // ===============================
    // 10. QUICK STATS
    // ===============================
    const quickStats = await sequelize.query(`
      SELECT 
        branch_id AS "branchId",
        COUNT(*) FILTER (WHERE status='approved') AS "approvedQuotations",
        COUNT(*) FILTER (WHERE status='invoiced') AS "invoicesGenerated",
        COUNT(*) FILTER (WHERE status='pending') AS "pendingApprovals"
      FROM quotations
      ${whereClause}
      GROUP BY branch_id
    `);

    // ===============================
    // 🔥 SUPER → GROUP DATA SAFE
    // ===============================
    let groupedData = null;

    if (isSuperSales) {
      const grouped = {};

      const init = (b) => {
        if (!grouped[b]) {
          grouped[b] = {
            branchId: b,
            cards: {},
            revenueTrend: [],
            categoryDistribution: [],
            weeklyActivity: [],
            profitAnalysis: [],
            topProducts: [],
            recentTransactions: [],
            inventoryStatus: {},
            clientBreakdown: {},
            quickStats: {}
          };
        }
      };

      (cards[0] || []).forEach(i => { init(i.branchId); grouped[i.branchId].cards = i; });
      (revenueTrend[0] || []).forEach(i => { init(i.branchId); grouped[i.branchId].revenueTrend.push(i); });
      (categoryDistribution[0] || []).forEach(i => { init(i.branchId); grouped[i.branchId].categoryDistribution.push(i); });
      (weeklyActivity[0] || []).forEach(i => { init(i.branchId); grouped[i.branchId].weeklyActivity.push(i); });
      (profitAnalysis[0] || []).forEach(i => { init(i.branchId); grouped[i.branchId].profitAnalysis.push(i); });
      (topProducts[0] || []).forEach(i => { init(i.branchId); grouped[i.branchId].topProducts.push(i); });
      (recentTransactions[0] || []).forEach(i => { init(i.branchId); grouped[i.branchId].recentTransactions.push(i); });
      (inventoryStatus[0] || []).forEach(i => { init(i.branchId); grouped[i.branchId].inventoryStatus = i; });
      (clientBreakdown[0] || []).forEach(i => { init(i.branchId); grouped[i.branchId].clientBreakdown = i; });
      (quickStats[0] || []).forEach(i => { init(i.branchId); grouped[i.branchId].quickStats = i; });

      groupedData = Object.values(grouped);
    }

    // ===============================
    // FINAL RESPONSE
    // ===============================
    return res.json({
      success: true,

      ...(isSuperSales
        ? { branches: groupedData || [] }
        : {
            cards: cards[0]?.[0] || {},
            revenueTrend: revenueTrend[0] || [],
            categoryDistribution: categoryDistribution[0] || [],
            weeklyActivity: weeklyActivity[0] || [],
            profitAnalysis: profitAnalysis[0] || [],
            topProducts: topProducts[0] || [],
            recentTransactions: recentTransactions[0] || [],
            inventoryStatus: inventoryStatus[0]?.[0] || {},
            clientBreakdown: clientBreakdown[0]?.[0] || {},
            quickStats: quickStats[0]?.[0] || {}
          })
    });

  } catch (err) {
    console.error("❌ REPORT ERROR:", err);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
};

//top screen work on this 
exports.getAdvancedSalesAnalytics = async (req, res) => {
  try {
    const branchId = req.user?.branch_id || null;
    const role = req.user?.role || "";

    const isSuperSales = role === "super_sales_manager";

    const whereClause = isSuperSales
      ? ""
      : branchId
      ? `WHERE branch_id = ${branchId}`
      : "";

    // ===============================
    // 1. QUICK ACTION CARDS (🔥 FIXED ONLY THIS PART)
    // ===============================
    const quickCards = await sequelize.query(`
      SELECT 
        COALESCE(SUM(total_amount),0) AS "totalSale",
        COUNT(*) AS "totalOrders",

        COUNT(*) FILTER (WHERE status='pending') AS "pendingQuotation",
        COUNT(*) FILTER (WHERE status='invoiced') AS "readyToDispatch"

      FROM quotations

      ${isSuperSales ? "" : branchId ? `WHERE branch_id = ${branchId}` : ""}
    `);

    // ===============================
    // 2. SALES ANALYTICS (UNCHANGED)
    // ===============================
    const salesAnalytics = await sequelize.query(`
      SELECT 
        branch_id AS "branchId",
        TO_CHAR("createdAt",'Mon') AS month,

        SUM(CASE WHEN reference_no IS NOT NULL THEN total_amount ELSE 0 END) AS "onlineSales",
        SUM(CASE WHEN reference_no IS NULL THEN total_amount ELSE 0 END) AS "offlineSales"

      FROM quotations
      ${whereClause}
      GROUP BY branch_id, month, DATE_TRUNC('month',"createdAt")
      ORDER BY branch_id, DATE_TRUNC('month',"createdAt")
    `);

    // ===============================
    // 3. QUOTATION STATUS (UNCHANGED)
    // ===============================
    const quotationStatus = await sequelize.query(`
      SELECT 
        branch_id AS "branchId",

        COUNT(*) FILTER (WHERE status='pending') AS "pending",
        COUNT(*) FILTER (WHERE status='approved') AS "approved",
        COUNT(*) FILTER (WHERE status='rejected') AS "rejected",
        COUNT(*) FILTER (WHERE status='invoiced') AS "invoiced",

        COALESCE(SUM(total_amount),0) AS "totalValue"

      FROM quotations
      ${whereClause}
      GROUP BY branch_id
    `);

    // ===============================
    // 4. CATEGORY SALES (UNCHANGED)
    // ===============================
    const categorySales = await sequelize.query(`
      SELECT 
        q.branch_id AS "branchId",
        qi.product_name AS category,
        SUM(qi.quantity) AS units,
        SUM(qi.amount) AS revenue

      FROM quotation_items qi
      JOIN quotations q ON q.id = qi.quotation_id

      ${isSuperSales ? "" : branchId ? `WHERE q.branch_id = ${branchId}` : ""}

      GROUP BY q.branch_id, qi.product_name
      ORDER BY q.branch_id, units DESC
    `);

    // ===============================
    // 5. RECENT ACTIVITY (UNCHANGED)
    // ===============================
    const recentActivity = await sequelize.query(`
      SELECT 
        q.branch_id AS "branchId",
        q.quotation_no,
        c.name AS client,
        q.total_amount,
        q.status,
        q."createdAt"

      FROM quotations q
      LEFT JOIN clients c ON c.id = q.client_id

      ${isSuperSales ? "" : branchId ? `WHERE q.branch_id = ${branchId}` : ""}

      ORDER BY q.branch_id, q."createdAt" DESC
      LIMIT 20
    `);

    // ===============================
    // 🔥 SUPER → GROUP BY BRANCH (UNCHANGED)
    // ===============================
    let groupedData = null;

    if (isSuperSales) {
      const grouped = {};

      const init = (b) => {
        if (!grouped[b]) {
          grouped[b] = {
            branchId: b,
            salesAnalytics: [],
            quotationStatus: {},
            categorySales: [],
            recentActivity: []
          };
        }
      };

      salesAnalytics[0].forEach(i => {
        init(i.branchId);
        grouped[i.branchId].salesAnalytics.push(i);
      });

      quotationStatus[0].forEach(i => {
        init(i.branchId);
        grouped[i.branchId].quotationStatus = i;
      });

      categorySales[0].forEach(i => {
        init(i.branchId);
        grouped[i.branchId].categorySales.push(i);
      });

      recentActivity[0].forEach(i => {
        init(i.branchId);
        grouped[i.branchId].recentActivity.push(i);
      });

      groupedData = Object.values(grouped);
    }

    // ===============================
    // FINAL RESPONSE (UNCHANGED STRUCTURE)
    // ===============================
    res.json({
      success: true,

      quickAction: quickCards[0][0], // ✅ now total data

      ...(isSuperSales
        ? { branches: groupedData }
        : {
            salesAnalytics: salesAnalytics[0],
            quotationStatus: quotationStatus[0][0],
            categorySales: categorySales[0],
            recentActivity: recentActivity[0]
          })
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
    const role = req.user?.role || "";

    const isSuperSales = role === "super_sales_manager";

    const whereClause = isSuperSales
      ? ""
      : branchId
      ? `WHERE c.branch_id = ${branchId}`
      : "";

    const data = await sequelize.query(`
      SELECT 
        c.id AS "clientId",
        c.name AS "companyName",
        c.email,
        c.phone,
        c.branch_id AS "branchId",

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
      LEFT JOIN quotations q ON q.client_id = c.id

      ${whereClause}

      GROUP BY c.id
      ORDER BY c.branch_id, "totalAmount" DESC
    `);

    let clients = data[0];

    // 🔥 ONLY for super_sales_manager → group by branch
    if (isSuperSales) {
      const grouped = {};

      clients.forEach(client => {
        const branch = client.branchId;

        if (!grouped[branch]) {
          grouped[branch] = {
            branchId: branch,
            totalClients: 0,
            totalEntries: 0,
            totalAmount: 0,
            pendingAmount: 0,
            revenue: 0,
            clients: []
          };
        }

        grouped[branch].clients.push(client);

        // totals
        grouped[branch].totalClients += 1;
        grouped[branch].totalEntries += Number(client.totalEntries);
        grouped[branch].totalAmount += Number(client.totalAmount);
        grouped[branch].pendingAmount += Number(client.pendingAmount);
        grouped[branch].revenue += Number(client.revenue);
      });

      clients = Object.values(grouped);
    }

    // 🔥 OLD branchSummary untouched (as you wanted)
    let branchSummary = [];

    if (isSuperSales) {
      const branchData = await sequelize.query(`
        SELECT 
          c.branch_id AS "branchId",

          COUNT(DISTINCT c.id) AS "totalClients",
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
        LEFT JOIN quotations q ON q.client_id = c.id

        GROUP BY c.branch_id
        ORDER BY "totalAmount" DESC
      `);

      branchSummary = branchData[0];
    }

    res.json({
      success: true,
      clients, // 👈 same key, bas super me grouped aa raha
      ...(isSuperSales && { branchSummary })
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
    const role = req.user?.role || "";

    const isSuperSales = role === "super_sales_manager";

    // 🔥 Branch filter (ONLY for non-super)
    const branchFilter = isSuperSales
      ? ""
      : branchId
      ? `AND q.branch_id = ${branchId}`
      : "";

    const data = await sequelize.query(`
      SELECT 
        q.id AS "entryId",
        q.quotation_no AS "transactionId",
        c.name AS "client",
        q.branch_id AS "branchId",

        TO_CHAR(q."createdAt", 'DD/MM/YYYY, HH24:MI:SS') AS "dateTime",

        COALESCE(q.total_amount,0) AS "amount",

        COALESCE(
          CASE 
            WHEN q.status = 'invoiced' THEN q.total_amount
            ELSE 0
          END
        ,0) AS "receivedAmount",

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
      ${branchFilter}

      ORDER BY q."createdAt" DESC
    `, {
      replacements: { clientId }
    });

    res.json({
      success: true,
      totalEntries: data[0].length,
      ledger: data[0] // 👈 same structure (no breaking change)
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
    const role = req.user?.role || "";

    const isSuperSales = role === "super_sales_manager";

    const whereClause = isSuperSales
      ? ""
      : branchId
      ? `WHERE branch_id = ${branchId}`
      : "";

    // ===============================
    // 1. TOP CARDS (UNCHANGED LOGIC)
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
    const invoicesData = await sequelize.query(`
      SELECT 
        q.id,
        q.branch_id AS "branchId",
        q.quotation_no AS "invoiceNo",
        c.name AS client,
        q.total_amount AS amount,
        q.status,

        TO_CHAR(q."createdAt", 'DD/MM/YYYY, HH24:MI') AS date,
        q.reference_no AS "quotationRef"

      FROM quotations q
      LEFT JOIN clients c ON c.id = q.client_id

      ${isSuperSales ? "" : branchId ? `WHERE q.branch_id = ${branchId}` : ""}

      ORDER BY q.branch_id, q."createdAt" DESC
      LIMIT 50
    `);

    let invoices = invoicesData[0];

    // ===============================
    // 🔥 SUPER → GROUP BY BRANCH
    // ===============================
    if (isSuperSales) {
      const grouped = {};

      invoices.forEach(inv => {
        const branch = inv.branchId;

        if (!grouped[branch]) {
          grouped[branch] = {
            branchId: branch,
            totalInvoices: 0,
            totalAmount: 0,
            pending: 0,
            invoiced: 0,
            rejected: 0,
            invoices: []
          };
        }

        grouped[branch].invoices.push(inv);

        // totals
        grouped[branch].totalInvoices += 1;
        grouped[branch].totalAmount += Number(inv.amount);

        if (inv.status === "pending") grouped[branch].pending++;
        if (inv.status === "invoiced") grouped[branch].invoiced++;
        if (inv.status === "rejected") grouped[branch].rejected++;
      });

      invoices = Object.values(grouped);
    }

    // ===============================
    // FINAL RESPONSE
    // ===============================
    res.json({
      success: true,
      stats: stats[0][0],
      invoices // 👈 same key, bas super me grouped
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
};
exports.getSuperAdminDashboard = async (req, res) => {
  try {

    const quotations = await Quotation.findAll({
      attributes: [
        "id",
        "total_amount",
        "status",
        "createdAt"
      ],
      include: [
        {
          model: Client,
          as: "client",
          attributes: ["id", "name", "address"]
        },
        {
          model: Branch,
          as: "branch",
          attributes: ["id", "name", "location"]
        }
      ]
    });

    // =========================
    // 🧠 GROUPING
    // =========================
    const dashboard = {};

    quotations.forEach((q) => {

      // 🔥 extract state + city
      let state = "Unknown";
      let city = "Unknown";

      if (q.client?.address) {
        const parts = q.client.address.split(",");

        state = parts[parts.length - 1]?.trim() || "Unknown";
        city = parts[parts.length - 2]?.trim() || "Unknown";
      }

      const branchName = q.branch?.name || "Unknown";

      // =========================
      // INIT STRUCTURE
      // =========================

      if (!dashboard[state]) dashboard[state] = {};
      if (!dashboard[state][city]) dashboard[state][city] = {};
      if (!dashboard[state][city][branchName]) {
        dashboard[state][city][branchName] = {
          total_quotations: 0,
          total_amount: 0,
          pending: 0,
          approved: 0,
          rejected: 0,
          invoiced: 0,
          top_clients: {}
        };
      }

      const branchData = dashboard[state][city][branchName];

      // =========================
      // COUNTING
      // =========================
      branchData.total_quotations += 1;
      branchData.total_amount += q.total_amount || 0;

      if (q.status === "pending") branchData.pending += 1;
      if (q.status === "approved") branchData.approved += 1;
      if (q.status === "rejected") branchData.rejected += 1;
      if (q.status === "invoiced") branchData.invoiced += 1;

      // =========================
      // TOP CLIENTS
      // =========================
      const clientName = q.client?.name || "Unknown";

      if (!branchData.top_clients[clientName]) {
        branchData.top_clients[clientName] = 0;
      }

      branchData.top_clients[clientName] += 1;
    });

    // =========================
    // 🔝 TOP CLIENT FORMAT
    // =========================
    Object.keys(dashboard).forEach((state) => {
      Object.keys(dashboard[state]).forEach((city) => {
        Object.keys(dashboard[state][city]).forEach((branch) => {

          const clients = dashboard[state][city][branch].top_clients;

          const sorted = Object.entries(clients)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);

          dashboard[state][city][branch].top_clients = sorted;
        });
      });
    });

    res.json({
      success: true,
      data: dashboard
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: err.message
    });
  }
};

exports.getStateWiseSales = async (req, res) => {
  try {

    const branchId = req.user?.branch_id || null;
    let role = req.user?.role || "";

    if (typeof role === "object") role = role.name;

    const isSuper = role === "super_sales_manager";

    const whereClause = isSuper
      ? ""
      : branchId
      ? `WHERE q.branch_id = ${branchId}`
      : "";

    const data = await sequelize.query(`
      SELECT 
        b.state AS "state",
        b.name AS "branchName",
        b.location AS "city",
        q.branch_id AS "branchId",

        COUNT(q.id) AS "totalOrders",

        COALESCE(SUM(q.total_amount),0) AS "totalSales",

        COALESCE(SUM(
          CASE WHEN q.status != 'invoiced' THEN q.total_amount ELSE 0 END
        ),0) AS "pendingAmount",

        COALESCE(SUM(
          CASE WHEN q.status = 'invoiced' THEN q.total_amount ELSE 0 END
        ),0) AS "receivedAmount"

      FROM quotations q
      LEFT JOIN branches b ON b.id = q.branch_id

      ${whereClause}

      GROUP BY b.state, b.name, b.location, q.branch_id
      ORDER BY b.state, "totalSales" DESC
    `);

    const grouped = {};

    data[0].forEach(item => {
      const state = item.state || "Unknown";

      if (!grouped[state]) {
        grouped[state] = {
          state,
          totalSales: 0,
          pendingAmount: 0,
          receivedAmount: 0,
          branches: []
        };
      }

      grouped[state].branches.push({
        branchId: item.branchId,
        branchName: item.branchName,
        city: item.city,
        totalOrders: Number(item.totalOrders),
        totalSales: Number(item.totalSales),
        pendingAmount: Number(item.pendingAmount),
        receivedAmount: Number(item.receivedAmount)
      });

      grouped[state].totalSales += Number(item.totalSales);
      grouped[state].pendingAmount += Number(item.pendingAmount);
      grouped[state].receivedAmount += Number(item.receivedAmount);
    });

    res.json({
      success: true,
      data: Object.values(grouped)
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
};
exports.getBranchesByState = async (req, res) => {
  try {

    const { state } = req.params;

    let role = req.user?.role || "";
    if (typeof role === "object") role = role.name;

    const branchId = req.user?.branch_id || null;
    const isSuper = role === "super_sales_manager";

    const whereClause = isSuper
      ? `WHERE TRIM(SPLIT_PART(c.address, ',', array_length(string_to_array(c.address, ','),1))) = :state`
      : branchId
      ? `WHERE q.branch_id = ${branchId}
         AND TRIM(SPLIT_PART(c.address, ',', array_length(string_to_array(c.address, ','),1))) = :state`
      : "";

    const data = await sequelize.query(`
      SELECT 
        q.branch_id AS "branchId",

        COUNT(q.id) AS "totalOrders",

        COALESCE(SUM(q.total_amount),0) AS "totalSales",

        COALESCE(SUM(
          CASE 
            WHEN q.status != 'invoiced' THEN q.total_amount 
            ELSE 0 
          END
        ),0) AS "pendingAmount",

        COALESCE(SUM(
          CASE 
            WHEN q.status = 'invoiced' THEN q.total_amount 
            ELSE 0 
          END
        ),0) AS "receivedAmount"

      FROM quotations q

      LEFT JOIN clients c ON c.id = q.client_id

      ${whereClause}

      GROUP BY q.branch_id
      ORDER BY "totalSales" DESC
    `, {
      replacements: { state }
    });

    res.json({
      success: true,
      state,
      branches: data[0]
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
};


exports.getStateDetailsDashboard = async (req, res) => {
  try {

    const user = req.user;
    const role = user?.role?.name || user?.role;

    const SUPER_ROLES = [
      "super_stock_manager",
      "super_admin",
      "super_sales_manager",
      "super_inventory_manager"
    ];

    // =========================
    // 🔐 ACCESS CONTROL
    // =========================
    if (!SUPER_ROLES.includes(role)) {
      return res.status(403).json({
        success: false,
        message: "❌ Access Denied"
      });
    }

    const { stateName } = req.params;

    // =========================
    // 🔥 BRANCH FILTER (IMPORTANT)
    // =========================
    const branchFilter = getBranchFilter(user);

    let branchCondition = "";
    let replacements = { stateName };

    // 👉 APPLY FILTER ONLY IF NOT SUPER
    if (Object.keys(branchFilter).length > 0) {
      if (branchFilter.branch_id?.[Symbol.for("sequelize.operator")]) {
        // safety (optional)
      }

      if (branchFilter.branch_id?.[Op.in]) {
        branchCondition = `AND b.id IN (:branchIds)`;
        replacements.branchIds = branchFilter.branch_id[Op.in];
      } else if (branchFilter.branch_id) {
        branchCondition = `AND b.id = :branchId`;
        replacements.branchId = branchFilter.branch_id;
      }
    }

    // =========================
    // 📊 BRANCH SUMMARY
    // =========================
    const branchData = await sequelize.query(`
      SELECT 
        b.id AS "branchId",
        b.name AS "branchName",

        COUNT(DISTINCT b.id) AS "totalBranches",

        COALESCE(SUM(s.quantity),0) AS "totalStock",
        COALESCE(SUM(s.value),0) AS "totalValue",

        COALESCE(SUM(s.quantity),0) AS "currentStock",

        COALESCE(SUM(
          CASE WHEN l.type = 'PURCHASE' THEN l.quantity ELSE 0 END
        ),0) AS "stockIn",

        COALESCE(SUM(
          CASE WHEN l.type = 'SALE' THEN l.quantity ELSE 0 END
        ),0) AS "stockOut",

        COALESCE(SUM(
          CASE WHEN l.type = 'PURCHASE' THEN 1 ELSE 0 END
        ),0) AS "purchaseCount",

        COALESCE(SUM(
          CASE WHEN l.type = 'SALE' THEN 1 ELSE 0 END
        ),0) AS "salesCount"

      FROM branches b
      LEFT JOIN stocks s ON s.branch_id = b.id
      LEFT JOIN ledger l ON l.branch_id = b.id

      WHERE b.state = :stateName
      ${branchCondition}

      GROUP BY b.id
      ORDER BY "totalValue" DESC
    `, {
      replacements
    });

    // =========================
    // 📊 CHART DATA
    // =========================
    const chartData = branchData[0].map((b) => ({
      label: b.branchName,
      value: Number(b.totalValue)
    }));

    // =========================
    // 🔝 TOP BRANCHES
    // =========================
    const topBranches = [...branchData[0]]
      .sort((a, b) => Number(b.totalValue) - Number(a.totalValue))
      .slice(0, 5);

    // =========================
    // 📈 SUMMARY
    // =========================
    const summary = await sequelize.query(`
      SELECT 
        COALESCE(SUM(s.value),0) AS "totalStockValue",
        COALESCE(SUM(s.quantity),0) AS "currentStock",
        COUNT(s.id) AS "totalItems",

        COALESCE(SUM(
          CASE WHEN l.type = 'PURCHASE' THEN l.quantity ELSE 0 END
        ),0) AS "stockIn",

        COALESCE(SUM(
          CASE WHEN l.type = 'SALE' THEN l.quantity ELSE 0 END
        ),0) AS "stockOut"

      FROM branches b
      LEFT JOIN stocks s ON s.branch_id = b.id
      LEFT JOIN ledger l ON l.branch_id = b.id

      WHERE b.state = :stateName
      ${branchCondition}
    `, {
      replacements
    });

    // =========================
    // ✅ FINAL RESPONSE
    // =========================
    return res.json({
      success: true,
      state: stateName,
      summary: summary[0][0],
      branches: branchData[0],
      charts: {
        branchValueChart: chartData
      },
      topBranches
    });

  } catch (err) {
    console.error("ERROR:", err);
    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
};


exports.getAllStatesDashboard = async (req, res) => {
  try {
    const role = req.user?.role?.name || req.user?.role;

    const SUPER_ROLES = [
      "super_stock_manager",
      "super_admin",
      "super_sales_manager",
      "super_inventory_manager"
    ];

    if (!SUPER_ROLES.includes(role)) {
      return res.status(403).json({
        success: false,
        message: "❌ Access Denied"
      });
    }

    // =========================
    // 🟦 CARDS
    // =========================
    const summaryData = await sequelize.query(`
      SELECT 
        COALESCE(SUM(CASE WHEN type='SALE' THEN total ELSE 0 END),0) AS "totalRevenue",
        COALESCE(SUM(CASE WHEN type='PURCHASE' THEN total ELSE 0 END),0) AS "totalPurchase",
        COALESCE(SUM(CASE WHEN type='SALE' THEN quantity ELSE 0 END),0) AS "totalSales"
      FROM ledger
    `, { type: QueryTypes.SELECT });

    const totalRevenue = Number(summaryData[0].totalRevenue || 0);
    const totalPurchase = Number(summaryData[0].totalPurchase || 0);
    const totalSales = Number(summaryData[0].totalSales || 0);

    const branchCount = await sequelize.query(`
      SELECT COUNT(*) AS count FROM branches
    `, { type: QueryTypes.SELECT });

    // =========================
    // 📊 SALES TREND (FIXED)
    // =========================
    const salesTrend = await sequelize.query(`
      SELECT 
        DATE_TRUNC('week', "createdAt") AS week,

        SUM(CASE WHEN type='SALE' THEN quantity ELSE 0 END) AS sales,
        SUM(CASE WHEN type='PURCHASE' THEN quantity ELSE 0 END) AS purchase

      FROM ledger
      GROUP BY week
      ORDER BY week ASC
    `, { type: QueryTypes.SELECT });

    // =========================
    // 📉 QUOTATION TREND (FIXED)
    // =========================
    const quotationTrend = await sequelize.query(`
      SELECT 
        DATE_TRUNC('week', "createdAt") AS week,

        COUNT(CASE WHEN status='pending' THEN 1 END) AS pending,
        COUNT(CASE WHEN status='rejected' THEN 1 END) AS rejected

      FROM quotations
      GROUP BY week
      ORDER BY week ASC
    `, { type: QueryTypes.SELECT });

    // =========================
    // 📋 STATE TABLE (NO DUPLICATE ISSUE)
    // =========================
    const statesData = await sequelize.query(`
      SELECT 
        UPPER(TRIM(b.state)) AS state,

        COUNT(DISTINCT b.id) AS "totalBranches",

        COALESCE(SUM(l.sales_qty),0) AS "totalSales",
        COALESCE(SUM(l.sales_amount),0) AS "totalRevenue",
        COALESCE(SUM(q.pending_qt),0) AS "pendingQuotation"

      FROM branches b

      LEFT JOIN (
        SELECT 
          branch_id,
          SUM(CASE WHEN type='SALE' THEN quantity ELSE 0 END) AS sales_qty,
          SUM(CASE WHEN type='SALE' THEN total ELSE 0 END) AS sales_amount
        FROM ledger
        GROUP BY branch_id
      ) l ON l.branch_id = b.id

      LEFT JOIN (
        SELECT 
          branch_id,
          COUNT(CASE WHEN status='pending' THEN 1 END) AS pending_qt
        FROM quotations
        GROUP BY branch_id
      ) q ON q.branch_id = b.id

      WHERE 
        b.state IS NOT NULL
        AND TRIM(b.state) != ''
        AND LOWER(TRIM(b.state)) NOT IN ('state','test','dummy')

      GROUP BY UPPER(TRIM(b.state))
      ORDER BY "totalRevenue" DESC
    `, { type: QueryTypes.SELECT });

    // =========================
    // 🧹 CLEAN DATA
    // =========================
    const cleanedStates = statesData.map(s => ({
      state: s.state,
      totalBranches: Number(s.totalBranches),
      totalSales: Number(s.totalSales),
      totalRevenue: Number(s.totalRevenue),
      pendingQuotation: Number(s.pendingQuotation)
    }));

    // =========================
    // 📊 STATE CHART
    // =========================
    const stateChart = cleanedStates.map(s => ({
      label: s.state,
      value: s.totalRevenue
    }));

    // =========================
    // 🔝 TOP STATES
    // =========================
    const topStates = [...cleanedStates]
      .sort((a, b) => b.totalRevenue - a.totalRevenue)
      .slice(0, 5);

    // =========================
    // ✅ FINAL RESPONSE
    // =========================
    return res.json({
      success: true,

      // 🟦 CARDS
      cards: {
        totalRevenue,
        totalProfit: totalRevenue - totalPurchase,
        totalSales,
        totalBranches: Number(branchCount[0].count)
      },

      // 📊 CHARTS
      charts: {
        salesTrend,
        quotationTrend,
        stateRevenueChart: stateChart
      },

      // 📋 TABLE
      states: cleanedStates,

      // 🔝 TOP
      topStates
    });

  } catch (err) {
    console.error("❌ ERROR:", err);
    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
};



exports.getStateDashboard = async (req, res) => {
  try {
    const role = req.user?.role?.name || req.user?.role;

    const SUPER_ROLES = [
      "super_stock_manager",
      "super_admin",
      "super_sales_manager",
      "super_inventory_manager"
    ];

    if (!SUPER_ROLES.includes(role)) {
      return res.status(403).json({
        success: false,
        message: "❌ Access Denied"
      });
    }

    const { state } = req.params;

    // =========================
    // 🟦 CARDS
    // =========================
    const summary = await sequelize.query(`
      SELECT 
        COALESCE(SUM(CASE WHEN l.type='SALE' THEN l.quantity ELSE 0 END),0) AS "totalSales",

        COALESCE(SUM(CASE WHEN q.status='pending' THEN 1 ELSE 0 END),0) AS "pendingQuotation",

        COALESCE(SUM(
          CASE 
            WHEN l.type='SALE' 
            AND DATE_TRUNC('month', l."createdAt") = DATE_TRUNC('month', CURRENT_DATE)
            THEN l.quantity 
            ELSE 0 
          END
        ),0) AS "salesThisMonth",

        COALESCE(COUNT(DISTINCT c.id),0) AS "totalClients"

      FROM branches b
      LEFT JOIN ledger l ON l.branch_id = b.id
      LEFT JOIN quotations q ON q.branch_id = b.id
      LEFT JOIN clients c ON c.branch_id = b.id

      WHERE UPPER(TRIM(b.state)) = UPPER(TRIM(:state))
    `, {
      replacements: { state },
      type: QueryTypes.SELECT
    });

    // =========================
    // 📊 STOCK IN / OUT CHART
    // =========================
    const stockChart = await sequelize.query(`
      SELECT 
        DATE_TRUNC('week', l."createdAt") AS week,

        SUM(CASE WHEN l.type='PURCHASE' THEN l.quantity ELSE 0 END) AS stockIn,
        SUM(CASE WHEN l.type='SALE' THEN l.quantity ELSE 0 END) AS stockOut

      FROM ledger l
      JOIN branches b ON b.id = l.branch_id

      WHERE UPPER(TRIM(b.state)) = UPPER(TRIM(:state))

      GROUP BY week
      ORDER BY week ASC
    `, {
      replacements: { state },
      type: QueryTypes.SELECT
    });

    // =========================
    // 📉 QUOTATION CHART
    // =========================
    const quotationChart = await sequelize.query(`
      SELECT 
        DATE_TRUNC('week', q."createdAt") AS week,

        COUNT(CASE WHEN q.status='pending' THEN 1 END) AS pending,
        COUNT(CASE WHEN q.status='rejected' THEN 1 END) AS rejected

      FROM quotations q
      JOIN branches b ON b.id = q.branch_id

      WHERE UPPER(TRIM(b.state)) = UPPER(TRIM(:state))

      GROUP BY week
      ORDER BY week ASC
    `, {
      replacements: { state },
      type: QueryTypes.SELECT
    });

    // =========================
    // 📋 BRANCH TABLE (NO DUPLICATE)
    // =========================
    const branches = await sequelize.query(`
      SELECT 
        b.id,
        b.name AS "branchName",

        COALESCE(l.sales_qty,0) AS "totalSales",
        COALESCE(l.sales_amount,0) AS "totalRevenue",

        COALESCE(c.total_clients,0) AS "totalClients",

        COALESCE(q.pending_qt,0) AS "pendingQuotation",
        COALESCE(q.rejected_qt,0) AS "rejectedQuotation"

      FROM branches b

      LEFT JOIN (
        SELECT 
          branch_id,
          SUM(CASE WHEN type='SALE' THEN quantity ELSE 0 END) AS sales_qty,
          SUM(CASE WHEN type='SALE' THEN total ELSE 0 END) AS sales_amount
        FROM ledger
        GROUP BY branch_id
      ) l ON l.branch_id = b.id

      LEFT JOIN (
        SELECT 
          branch_id,
          COUNT(*) FILTER (WHERE status='pending') AS pending_qt,
          COUNT(*) FILTER (WHERE status='rejected') AS rejected_qt
        FROM quotations
        GROUP BY branch_id
      ) q ON q.branch_id = b.id

      LEFT JOIN (
        SELECT 
          branch_id,
          COUNT(*) AS total_clients
        FROM clients
        GROUP BY branch_id
      ) c ON c.branch_id = b.id

      WHERE UPPER(TRIM(b.state)) = UPPER(TRIM(:state))
      ORDER BY "totalRevenue" DESC
    `, {
      replacements: { state },
      type: QueryTypes.SELECT
    });

    // =========================
    // 🧹 FINAL CLEAN RESPONSE
    // =========================
    return res.json({
      success: true,
      state,

      cards: {
        totalSales: Number(summary[0].totalSales),
        pendingQuotation: Number(summary[0].pendingQuotation),
        salesThisMonth: Number(summary[0].salesThisMonth),
        totalClients: Number(summary[0].totalClients)
      },

      charts: {
        stockTrend: stockChart,
        quotationTrend: quotationChart
      },

      branches: branches.map(b => ({
        ...b,
        totalSales: Number(b.totalSales),
        totalRevenue: Number(b.totalRevenue),
        totalClients: Number(b.totalClients),
        pendingQuotation: Number(b.pendingQuotation),
        rejectedQuotation: Number(b.rejectedQuotation)
      }))
    });

  } catch (err) {
    console.error("❌ ERROR:", err);
    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
};

exports.getBranchDashboard = async (req, res) => {
  try {
    const role = req.user?.role?.name || req.user?.role;

    const SUPER_ROLES = [
      "super_stock_manager",
      "super_admin",
      "super_sales_manager",
      "super_inventory_manager"
    ];

    if (!SUPER_ROLES.includes(role)) {
      return res.status(403).json({
        success: false,
        message: "❌ Access Denied"
      });
    }

    const { branchId } = req.params;

    // =========================
    // 🟦 CARDS
    // =========================
    const summary = await sequelize.query(`
      SELECT 
        COALESCE(SUM(CASE WHEN type='SALE' THEN quantity ELSE 0 END),0) AS "totalSales",

        COALESCE(SUM(
          CASE WHEN type='SALE' AND DATE_TRUNC('month', "createdAt") = DATE_TRUNC('month', CURRENT_DATE)
          THEN quantity ELSE 0 END
        ),0) AS "salesThisMonth",

        COALESCE(SUM(
          CASE WHEN type='SALE' THEN total ELSE 0 END
        ),0) AS "totalRevenue"

      FROM ledger
      WHERE branch_id = :branchId
    `, {
      replacements: { branchId },
      type: QueryTypes.SELECT
    });

    // Pending QT
    const pendingQT = await sequelize.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status='pending') AS pending,
        COUNT(*) FILTER (WHERE status='rejected') AS rejected
      FROM quotations
      WHERE branch_id = :branchId
    `, {
      replacements: { branchId },
      type: QueryTypes.SELECT
    });

    // Clients
    const clientCount = await sequelize.query(`
      SELECT COUNT(*) AS total FROM clients WHERE branch_id = :branchId
    `, {
      replacements: { branchId },
      type: QueryTypes.SELECT
    });

    // =========================
    // 📊 STOCK IN / OUT CHART
    // =========================
    const stockChart = await sequelize.query(`
      SELECT 
        DATE_TRUNC('week', "createdAt") AS week,

        SUM(CASE WHEN type='PURCHASE' THEN quantity ELSE 0 END) AS stockIn,
        SUM(CASE WHEN type='SALE' THEN quantity ELSE 0 END) AS stockOut

      FROM ledger
      WHERE branch_id = :branchId

      GROUP BY week
      ORDER BY week ASC
    `, {
      replacements: { branchId },
      type: QueryTypes.SELECT
    });

    // =========================
    // 📉 QUOTATION CHART
    // =========================
    const quotationChart = await sequelize.query(`
      SELECT 
        DATE_TRUNC('week', "createdAt") AS week,

        COUNT(CASE WHEN status='pending' THEN 1 END) AS pending,
        COUNT(CASE WHEN status='rejected' THEN 1 END) AS rejected

      FROM quotations
      WHERE branch_id = :branchId

      GROUP BY week
      ORDER BY week ASC
    `, {
      replacements: { branchId },
      type: QueryTypes.SELECT
    });

    // =========================
    // 📋 PRODUCT TABLE (TOP ITEMS)
    // =========================
    const products = await sequelize.query(`
      SELECT 
        s.item AS "productName",
        s.category AS "category",

        SUM(CASE WHEN l.type='SALE' THEN l.quantity ELSE 0 END) AS "totalSales",
        SUM(CASE WHEN l.type='SALE' THEN l.total ELSE 0 END) AS "totalRevenue",

        COUNT(DISTINCT c.id) AS "clients",

        COUNT(CASE WHEN q.status='pending' THEN 1 END) AS "pendingQuotation",
        COUNT(CASE WHEN q.status='rejected' THEN 1 END) AS "rejectedQuotation"

      FROM stocks s
      LEFT JOIN ledger l ON l.stock_id = s.id
      LEFT JOIN quotations q ON q.branch_id = s.branch_id
      LEFT JOIN clients c ON c.branch_id = s.branch_id

      WHERE s.branch_id = :branchId

      GROUP BY s.item, s.category
      ORDER BY "totalRevenue" DESC
      LIMIT 10
    `, {
      replacements: { branchId },
      type: QueryTypes.SELECT
    });

    // =========================
    // ✅ FINAL RESPONSE
    // =========================
    return res.json({
      success: true,

      cards: {
        totalSales: Number(summary[0].totalSales),
        pendingQuotation: Number(pendingQT[0].pending),
        salesThisMonth: Number(summary[0].salesThisMonth),
        totalClients: Number(clientCount[0].total)
      },

      charts: {
        stockTrend: stockChart,
        quotationTrend: quotationChart
      },

      products: products.map(p => ({
        productName: p.productName,
        category: p.category,
        totalSales: Number(p.totalSales),
        totalRevenue: Number(p.totalRevenue),
        clients: Number(p.clients),
        pendingQuotation: Number(p.pendingQuotation),
        rejectedQuotation: Number(p.rejectedQuotation)
      }))
    });

  } catch (err) {
    console.error("❌ ERROR:", err);
    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
};

exports.getItemDashboard = async (req, res) => {
  try {
    const { itemId } = req.params;

  
    const summary = await sequelize.query(`
      SELECT 
        COALESCE(SUM(l.quantity),0) AS "totalQty",
        COALESCE(SUM(s.value),0) AS "stockValue",

        COALESCE(SUM(
          CASE WHEN l.type='SALE' THEN l.total ELSE 0 END
        ),0) AS "totalRevenue",

        COUNT(l.id) AS "totalInvoices"

      FROM ledger l
      JOIN stocks s ON s.id = l.stock_id

      WHERE l.stock_id = :itemId
    `, {
      replacements: { itemId },
      type: QueryTypes.SELECT
    });


    const stockChart = await sequelize.query(`
      SELECT 
        DATE_TRUNC('week', l."createdAt") AS week,

        SUM(CASE WHEN l.type='SALE' THEN l.quantity ELSE 0 END) AS sales,
        SUM(CASE WHEN l.type='PURCHASE' THEN l.quantity ELSE 0 END) AS purchase

      FROM ledger l
      WHERE l.stock_id = :itemId

      GROUP BY week
      ORDER BY week ASC
    `, {
      replacements: { itemId },
      type: QueryTypes.SELECT
    });

    const revenueChart = await sequelize.query(`
      SELECT 
        DATE_TRUNC('week', l."createdAt") AS week,

        SUM(CASE WHEN l.type='SALE' THEN l.total ELSE 0 END) AS revenue,
        SUM(CASE WHEN l.type='PURCHASE' THEN l.total ELSE 0 END) AS cost

      FROM ledger l
      WHERE l.stock_id = :itemId

      GROUP BY week
      ORDER BY week ASC
    `, {
      replacements: { itemId },
      type: QueryTypes.SELECT
    });

 
    const tableData = await sequelize.query(`
      SELECT 
        l."createdAt" AS date,

        l.reference_no AS "invoiceNumber",

        -- ✅ FIXED CLIENT (NO ERROR)
        'Direct Sale' AS "clientName",

        b.name AS "branch",

        l.quantity AS qty,
        l.rate,
        l.total AS amount,

        s.status,

        -- 🧠 AGING
        CASE 
          WHEN AGE(NOW(), l."createdAt") < INTERVAL '30 days' THEN '1 month'
          WHEN AGE(NOW(), l."createdAt") < INTERVAL '90 days' THEN '3 months'
          WHEN AGE(NOW(), l."createdAt") < INTERVAL '180 days' THEN '6 months'
          WHEN AGE(NOW(), l."createdAt") < INTERVAL '365 days' THEN '1 year'
          WHEN AGE(NOW(), l."createdAt") < INTERVAL '730 days' THEN '2 years'
          ELSE '2+ years'
        END AS "aging"

      FROM ledger l
      JOIN stocks s ON s.id = l.stock_id
      LEFT JOIN branches b ON b.id = l.branch_id

      WHERE l.stock_id = :itemId

      ORDER BY l."createdAt" DESC
      LIMIT 50
    `, {
      replacements: { itemId },
      type: QueryTypes.SELECT
    });

    
    const itemInfo = await sequelize.query(`
      SELECT item, category 
      FROM stocks 
      WHERE id = :itemId 
      LIMIT 1
    `, {
      replacements: { itemId },
      type: QueryTypes.SELECT
    });

   
    return res.json({
      success: true,

      item: itemInfo[0]?.item || "Unknown",
      category: itemInfo[0]?.category || "",

      cards: {
        totalQty: Number(summary[0].totalQty),
        stockValue: Number(summary[0].stockValue),
        totalRevenue: Number(summary[0].totalRevenue),
        totalInvoices: Number(summary[0].totalInvoices)
      },

      charts: {
        stockTrend: stockChart,
        revenueTrend: revenueChart
      },

      table: tableData.map(row => ({
        date: row.date,
        aging: row.aging,

        invoiceNumber: row.invoiceNumber,
        clientName: row.clientName,

        branch: row.branch,

        qty: Number(row.qty),
        rate: Number(row.rate),
        amount: Number(row.amount),

        status: row.status
      }))
    });

  } catch (err) {
    console.error("❌ ERROR:", err);
    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
};
