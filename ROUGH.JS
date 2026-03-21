const { Branch, Stock, sequelize } = require("../../../model/SQL_Model");
const { Op } = require("sequelize");



exports.getStockLocations = async (req, res) => {
  try {
    const locations = await Branch.findAll({
      attributes: [
        "location",
        [
          sequelize.fn("COUNT", sequelize.col("Branch.id")),
          "totalBranches"
        ],
        [
          sequelize.fn(
            "COALESCE",
            sequelize.fn("SUM", sequelize.col("stocks.quantity")),
            0
          ),
          "totalStock"
        ],
        [
          sequelize.fn(
            "COALESCE",
            sequelize.fn("SUM", sequelize.col("stocks.value")),
            0
          ),
          "totalValue"
        ]
      ],
      include: [
        {
          model: Stock,
          as: "stocks",
          attributes: []
        }
      ],
      group: ["location"],
      raw: true
    });

    res.json({ locations });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};


// ==========================================
// 2️⃣ GET BRANCH LIST BY LOCATION
// ==========================================
exports.getBranchesByLocation = async (req, res) => {
  try {
    const { location } = req.params;

    const branches = await Branch.findAll({
      where: { location },
      attributes: [
        "id",
        "name",
        [
          sequelize.fn(
            "COALESCE",
            sequelize.fn("SUM", sequelize.col("stocks.quantity")),
            0
          ),
          "totalStock"
        ]
      ],
      include: [
        {
          model: Stock,
          as: "stocks",
          attributes: []
        }
      ],
      group: ["Branch.id"],
      raw: true
    });

    res.json({ branches });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};


// ==========================================
// 3️⃣ GET BRANCH DASHBOARD
// ==========================================
exports.getBranchDashboard = async (req, res) => {
  try {
    const { branchId } = req.params;

    const totalStock =
      (await Stock.sum("quantity", {
        where: { branch_id: branchId }
      })) || 0;

    const totalValue =
      (await Stock.sum("value", {
        where: { branch_id: branchId }
      })) || 0;

    const lowStock = await Stock.count({
      where: {
        branch_id: branchId,
        quantity: { [Op.lt]: 5 }
      }
    });

    const damagedStock = await Stock.count({
      where: {
        branch_id: branchId,
        status: "DAMAGED"
      }
    });

    // Category Chart
    const categoryChart = await Stock.findAll({
      where: { branch_id: branchId },
      attributes: [
        "category",
        [sequelize.fn("SUM", sequelize.col("quantity")), "qty"]
      ],
      group: ["category"],
      raw: true
    });

    // Monthly Trend (PostgreSQL safe)
    const monthlyTrend = await Stock.findAll({
      where: { branch_id: branchId },
      attributes: [
        [
          sequelize.fn(
            "TO_CHAR",
            sequelize.col("created_at"),
            "YYYY-MM"
          ),
          "month"
        ],
        [sequelize.fn("SUM", sequelize.col("quantity")), "stock"]
      ],
      group: [
        sequelize.fn(
          "TO_CHAR",
          sequelize.col("created_at"),
          "YYYY-MM"
        )
      ],
      raw: true
    });

    // Table Data
    const stocks = await Stock.findAll({
      where: { branch_id: branchId },
      order: [["created_at", "DESC"]]
    });

    res.json({
      stats: {
        totalStock,
        totalValue,
        lowStock,
        damagedStock
      },
      charts: {
        categoryChart,
        monthlyTrend
      },
      stocks
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getStockManagerHeadDashboard = async (req, res) => {
  try {

    // ========================
    // GLOBAL STATS
    // ========================
    const totalStock = (await Stock.sum("quantity")) || 0;

    const totalValue = (await Stock.sum("value")) || 0;

    const lowStock = await Stock.count({
      where: { quantity: { [Op.lt]: 5 } }
    });

    const scrapItems = await Stock.count({
      where: { status: "DAMAGED" }
    });

    const transitItems = (await Stock.sum("quantity", {
      where: { status: "REPAIRABLE" }
    })) || 0;


    // ========================
    // CATEGORY CHART (GLOBAL)
    // ========================
    const categoryChart = await Stock.findAll({
      attributes: [
        "category",
        [sequelize.fn("SUM", sequelize.col("quantity")), "qty"]
      ],
      group: ["category"],
      raw: true
    });


    // ========================
    // MONTHLY TREND (PostgreSQL Safe)
    // ========================
    const monthlyTrend = await Stock.findAll({
      attributes: [
        [
          sequelize.fn("TO_CHAR", sequelize.col("created_at"), "YYYY-MM"),
          "month"
        ],
        [sequelize.fn("SUM", sequelize.col("quantity")), "stock"]
      ],
      group: [
        sequelize.fn("TO_CHAR", sequelize.col("created_at"), "YYYY-MM")
      ],
      order: [
        [
          sequelize.fn("TO_CHAR", sequelize.col("created_at"), "YYYY-MM"),
          "ASC"
        ]
      ],
      raw: true
    });


    // ========================
    // COMPLETE INVENTORY TABLE
    // ========================
    const stocks = await Stock.findAll({
      include: [
        {
          model: Branch,
          as: "branch",
          attributes: ["id", "name", "location"]
        }
      ],
      order: [["created_at", "DESC"]]
    });


    res.json({
      stats: {
        totalStock,
        totalValue,
        lowStock,
        scrapItems,
        transitItems
      },
      charts: {
        categoryChart,
        monthlyTrend
      },
      stocks
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};



exports.createQuotation = async (req, res) => {

  const t = await sequelize.transaction();

  try {

    const {
      client,
      branch_id,
      products,
      gst_percent = 0,
      valid_till
    } = req.body;


    // =========================
    // CLIENT
    // =========================

    const clientData =
      await getOrCreateClient(
        { ...client, branch_id },
        t
      );


    // =========================
    // QUOTATION NO
    // =========================

    const last = await Quotation.findOne({
      where: { branch_id },
      order: [["createdAt", "DESC"]],
      transaction: t,
      lock: t.LOCK.UPDATE
    });

    let next = 1;

    if (last?.quotation_no) {

      const parts =
        last.quotation_no.split("-");

      next = Number(parts[2]) + 1;
    }

    const quotation_no =
      `QT-${branch_id}-${String(next).padStart(4, "0")}`;


    // =========================
    // TOTAL CALC
    // =========================

    let subtotal = 0;

    for (const p of products) {
      subtotal += p.quantity * p.unit_price;
    }

    const gst_amount =
      subtotal * gst_percent / 100;

    const grand_total =
      subtotal + gst_amount;


    // =========================
    // CREATE QUOTATION
    // =========================

    const quotation =
      await Quotation.create({

        quotation_no,
        client_id: clientData.id,
        branch_id,

        total_amount: grand_total,
        gst_amount,

        valid_till:
          valid_till || null,

        status: "pending"

      }, { transaction: t });


    // =========================
    // CREATE ITEMS
    // =========================

    for (const p of products) {

      const itemTotal =
        p.quantity * p.unit_price;

      const cgst =
        (itemTotal * gst_percent) / 200;

      const sgst =
        (itemTotal * gst_percent) / 200;

      await QuotationItem.create({

        quotation_id: quotation.id,

        product_name: p.product_name,

        quantity: p.quantity,

        unit_price: p.unit_price,

        unit: p.unit || "",

        hsn: p.hsn || "",

        cgst,

        sgst,

        subtotal: itemTotal,

        amount:
          itemTotal + cgst + sgst

      }, { transaction: t });

    }

    await t.commit();


    // =========================
    // GET DATA FOR PDF
    // =========================

    const branch =
      await Branch.findByPk(branch_id);

    const items =
      await QuotationItem.findAll({
        where: {
          quotation_id: quotation.id
        }
      });


    // =========================
    // HTML TEMPLATE
    // =========================

    const html =
      quotationHTML({
        branch,
        quotation,
        client: clientData,
        items
      });


    // =========================
    // PDF
    // =========================

    const browser =
      await puppeteer.launch();

    const page =
      await browser.newPage();

    await page.setContent(html, {
      waitUntil: "networkidle0"
    });

    const pdf =
      await page.pdf({
        format: "A4",
        printBackground: true
      });

    await browser.close();


    // =========================
    // SHOW IN BROWSER
    // =========================

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition":
        "inline; filename=quotation.pdf"
    });

    return res.send(pdf);

  }
  catch (err) {

    await t.rollback();

    res.status(500).json({
      error: err.message
    });

  }

};