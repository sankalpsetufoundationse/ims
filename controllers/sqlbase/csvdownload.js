const sequelize = require("../../config/sqlcon");
const ExcelJS = require("exceljs");

const { Op } = require("sequelize");

const Stock = require("../../model/SQL_Model/stock.record");
const Branch = require("../../model/SQL_Model/branch");


exports.exportStockAgingExcel = async (req, res) => {
  try {

    // ================= USER ROLE =================
    const role = req.user?.role || req.user?.role?.name;

    let isSuper = false;
    let branchIds = [];

    if (
      req.user?.branches?.includes("ALL") ||
      role === "super_admin"
    ) {
      isSuper = true;
    } else {
      if (Array.isArray(req.user?.branches) && req.user.branches.length) {
        branchIds = req.user.branches;
      } else if (req.user?.branch_id) {
        branchIds = [req.user.branch_id];
      }
    }

    if (!Array.isArray(branchIds)) {
      branchIds = [branchIds];
    }

    // ================= QUERY =================
    const [data] = await sequelize.query(`
      SELECT 
      po_number AS "purchaseOrderNo",
      item AS "itemName",
      category AS "categories",
      branch_id AS "branch",
      quantity,
      value,

      CASE
        WHEN NOW() - created_at <= INTERVAL '180 days' THEN 'Fresh'
        WHEN NOW() - created_at <= INTERVAL '365 days' THEN 'Normal'
        WHEN NOW() - created_at <= INTERVAL '730 days' THEN 'Slow'
        ELSE 'Critical'
      END AS status

      FROM stocks
      WHERE (
        :isSuper = true 
        OR branch_id IN (:branchIds)
      )
      ORDER BY created_at DESC
    `, {
      replacements: {
        isSuper,
        branchIds: branchIds.length ? branchIds : [0]
      }
    });

    if (!data.length) {
      return res.status(404).json({
        success: false,
        message: "No data found"
      });
    }

    // ================= EXCEL =================
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Stock Aging");

    // 🔥 HEADER
    worksheet.columns = [
      { header: "PO Number", key: "purchaseOrderNo", width: 25 },
      { header: "Item Name", key: "itemName", width: 20 },
      { header: "Category", key: "categories", width: 20 },
      { header: "Branch", key: "branch", width: 10 },
      { header: "Quantity", key: "quantity", width: 12 },
      { header: "Value", key: "value", width: 15 },
      { header: "Status", key: "status", width: 15 }
    ];

    // 🔥 STYLE HEADER
    worksheet.getRow(1).font = { bold: true };

    // 🔥 DATA
    data.forEach(row => {
      worksheet.addRow({
        purchaseOrderNo: row.purchaseOrderNo,
        itemName: row.itemName,
        categories: row.categories,
        branch: row.branch,
        quantity: row.quantity,
        value: row.value,
        status: row.status
      });
    });

    // 🔥 TOTAL ROW
    const totalValue = data.reduce((sum, row) => sum + (row.value || 0), 0);

    worksheet.addRow({});
    worksheet.addRow({
      itemName: "TOTAL",
      value: totalValue
    });

    // ================= DOWNLOAD =================
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename=stock-aging-${Date.now()}.xlsx`
    );

    await workbook.xlsx.write(res);

    res.end();

  } catch (err) {
    console.error("❌ EXCEL EXPORT ERROR:", err);

    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
};
exports.exportInventoryExcel = async (req, res) => {
  try {

    const user = req.user;
    const role = user?.role || user?.role?.name;
    const userBranches = user?.branches || [];

    if (!userBranches.length) {
      return res.status(403).json({
        success: false,
        message: "No branch access"
      });
    }

    // 👑 SUPER USER
    const isSuperUser =
      userBranches.includes("ALL") || role === "super_admin";

    const whereCondition = isSuperUser
      ? {}
      : {
          branch_id: {
            [Op.in]: userBranches
          }
        };

    // ================= DATA =================
    const data = await Stock.findAll({
      where: whereCondition,

      include: [
        {
          model: Branch,
          as: "branch",
          attributes: [
            "name",
            "code",
            "state",
            "type",
            "location",
            "contact_number",
            "email"
          ]
        }
      ],

      attributes: [
        "item",
        "category",
        "hsn",
        "grn",
        "po_number",
        ["quantity", "current_stock"],
        "status",

        [
          sequelize.literal(`(
            SELECT COALESCE(SUM(quantity),0)
            FROM ledger
            WHERE ledger.stock_id = "Stock"."id"
            AND ledger.type = 'PURCHASE'
          )`),
          "stock_in"
        ],

        [
          sequelize.literal(`(
            SELECT COALESCE(SUM(quantity),0)
            FROM ledger
            WHERE ledger.stock_id = "Stock"."id"
            AND ledger.type = 'SALE'
          )`),
          "stock_out"
        ],

        [
          sequelize.literal(`(
            SELECT COALESCE(SUM(quantity),0)
            FROM ledger
            WHERE ledger.stock_id = "Stock"."id"
            AND ledger.type = 'DAMAGE'
          )`),
          "scrap"
        ]
      ]
    });

    if (!data.length) {
      return res.status(404).json({
        success: false,
        message: "No inventory data"
      });
    }

    // ================= EXCEL =================
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Inventory Report");

    // 🔥 TOP INFO
    worksheet.addRow(["User Role:", role]);
    worksheet.addRow([
      "Branch Access:",
      isSuperUser ? "ALL BRANCHES" : userBranches.join(", ")
    ]);
    worksheet.addRow(["Generated At:", new Date().toLocaleString()]);
    worksheet.addRow([]);

    // 🔥 HEADER
    worksheet.columns = [
      { header: "Item", key: "item", width: 20 },
      { header: "Category", key: "category", width: 20 },
      { header: "HSN", key: "hsn", width: 15 },
      { header: "GRN", key: "grn", width: 20 },
      { header: "PO Number", key: "po_number", width: 25 },

      { header: "Branch Name", key: "branch_name", width: 25 },
      { header: "Branch Code", key: "branch_code", width: 15 },
      { header: "Branch Type", key: "branch_type", width: 15 },
      { header: "State", key: "state", width: 20 },
      { header: "Location", key: "location", width: 25 },
      { header: "Contact", key: "contact", width: 20 },
      { header: "Email", key: "email", width: 25 },

      { header: "Current Stock", key: "current_stock", width: 15 },
      { header: "Stock In", key: "stock_in", width: 15 },
      { header: "Stock Out", key: "stock_out", width: 15 },
      { header: "Scrap", key: "scrap", width: 15 },

      { header: "Status", key: "status", width: 15 }
    ];

    worksheet.getRow(5).font = { bold: true };

    // 🔥 DATA
    data.forEach(row => {
      worksheet.addRow({
        item: row.item,
        category: row.category,
        hsn: row.hsn,
        grn: row.grn,
        po_number: row.po_number,

        branch_name: row.branch?.name || "",
        branch_code: row.branch?.code || "",
        branch_type: row.branch?.type || "",
        state: row.branch?.state || "",
        location: row.branch?.location || "",
        contact: row.branch?.contact_number || "",
        email: row.branch?.email || "",

        current_stock: row.get("current_stock"),
        stock_in: row.get("stock_in"),
        stock_out: row.get("stock_out"),
        scrap: row.get("scrap"),

        status: row.status
      });
    });

    // 🔥 TOTAL
    const totalStock = data.reduce(
      (sum, r) => sum + (r.get("current_stock") || 0),
      0
    );

    worksheet.addRow([]);
    worksheet.addRow({
      item: "TOTAL",
      current_stock: totalStock
    });

    // ================= DOWNLOAD =================
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename=inventory-report-${Date.now()}.xlsx`
    );

    await workbook.xlsx.write(res);
    res.end();

  } catch (error) {
    console.error("❌ INVENTORY EXPORT ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Error exporting inventory"
    });
  }
};
exports.getReportsAnalyticsDashboard = async (req, res) => {
 
 
exports.exportReportsAnalyticsCSV = async (req, res) => {
  try {

    const user = req.user;
    const role = user?.role || user?.role?.name;

    let isSuper = false;
    let branchIds = [];

    if (
      user?.branches?.includes("ALL") ||
      role === "super_admin"
    ) {
      isSuper = true;
    } else {
      if (Array.isArray(user?.branches) && user.branches.length) {
        branchIds = user.branches;
      } else if (user?.branch_id) {
        branchIds = [user.branch_id];
      }
    }

    if (!Array.isArray(branchIds)) branchIds = [branchIds];

    const replacements = {
      isSuper,
      branchIds: branchIds.length ? branchIds : [0]
    };

    // ================= DATA =================
    const [cards] = await sequelize.query(`
      SELECT 
        COALESCE(SUM(value),0)::INTEGER AS "totalSpend",
        COUNT(id)::INTEGER AS "totalPOs",
        COALESCE(SUM(quantity),0)::INTEGER AS "totalStockItems",
        SUM(CASE WHEN quantity < 10 THEN 1 ELSE 0 END)::INTEGER AS "lowStockItems"
      FROM stocks
      WHERE (:isSuper = true OR branch_id IN (:branchIds))
    `, { replacements });

    const [monthlySpend] = await sequelize.query(`
      SELECT 
        TO_CHAR(created_at,'Mon') AS month,
        SUM(value)::INTEGER AS spend
      FROM stocks
      WHERE (:isSuper = true OR branch_id IN (:branchIds))
      GROUP BY month, DATE_PART('month',created_at)
      ORDER BY DATE_PART('month',created_at)
    `, { replacements });

    const [stockMovement] = await sequelize.query(`
      SELECT 
        TO_CHAR(created_at,'Mon') AS month,
        SUM(CASE WHEN type='IN' THEN quantity ELSE 0 END)::INTEGER AS "stockIn",
        SUM(CASE WHEN type='OUT' THEN quantity ELSE 0 END)::INTEGER AS "stockOut"
      FROM stock_movements
      WHERE (:isSuper = true OR branch_id IN (:branchIds))
      GROUP BY month, DATE_PART('month',created_at)
      ORDER BY DATE_PART('month',created_at)
    `, { replacements });

    const [categoryDistribution] = await sequelize.query(`
      SELECT 
        category,
        SUM(quantity)::INTEGER AS total
      FROM stocks
      WHERE (:isSuper = true OR branch_id IN (:branchIds))
      GROUP BY category
    `, { replacements });

    // ================= BUILD CSV MANUALLY =================
    let csv = "";

    // 🔥 USER INFO
    csv += `ROLE,${role}\n`;
    csv += `BRANCH,${isSuper ? "ALL" : branchIds.join(",")}\n\n`;

    // 🔥 CARDS
    csv += "=== SUMMARY ===\n";
    csv += "Total Spend,Total POs,Total Items,Low Stock\n";
    csv += `${cards[0].totalSpend},${cards[0].totalPOs},${cards[0].totalStockItems},${cards[0].lowStockItems}\n\n`;

    // 🔥 MONTHLY SPEND
    csv += "=== MONTHLY SPEND ===\n";
    csv += "Month,Spend\n";
    monthlySpend.forEach(r => {
      csv += `${r.month},${r.spend}\n`;
    });
    csv += "\n";

    // 🔥 STOCK MOVEMENT
    csv += "=== STOCK MOVEMENT ===\n";
    csv += "Month,Stock In,Stock Out\n";
    stockMovement.forEach(r => {
      csv += `${r.month},${r.stockIn},${r.stockOut}\n`;
    });
    csv += "\n";

    // 🔥 CATEGORY
    csv += "=== CATEGORY DISTRIBUTION ===\n";
    csv += "Category,Total\n";
    categoryDistribution.forEach(r => {
      csv += `${r.category},${r.total}\n`;
    });

    // ================= DOWNLOAD =================
    const csvWithBom = "\uFEFF" + csv;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=reports-${Date.now()}.csv`
    );

    return res.send(csvWithBom);

  } catch (err) {
    console.error("❌ CSV EXPORT ERROR:", err);

    res.status(500).json({
      success: false,
      message: err.message
    });
  }
};
};

exports.exportClientsExcel = async (req, res) => {
  try {

    const user = req.user;
    const role = user?.role || user?.role?.name;
    const userBranches = user?.branches || [];

    if (!userBranches.length) {
      return res.status(403).json({
        success: false,
        message: "No branch access"
      });
    }

    // 👑 SUPER USER
    const isSuperUser =
      userBranches.includes("ALL") || role === "super_admin";

    let replacements = {};
    let branchFilter = "";

    if (!isSuperUser) {
      replacements.branchId = user.branch_id;
      branchFilter = "WHERE c.branch_id = :branchId";
    }

    // ================= DATA =================
    const [clients] = await sequelize.query(`
      SELECT
      c.name AS "vendorName",
      c.email,
      c.phone,
      c.gst_number AS "gstNumber",

      COALESCE(SUM(CASE WHEN l.type='SALE' THEN l.amount ELSE 0 END),0) AS "totalAmount",

      COALESCE(
        SUM(CASE WHEN l.type='SALE' THEN l.amount ELSE 0 END) -
        SUM(CASE WHEN l.type='PAYMENT' THEN l.amount ELSE 0 END)
      ,0) AS "pendingAmount"

      FROM clients c
      LEFT JOIN client_ledger l
      ON l.client_id = c.id
      ${isSuperUser ? "" : "AND l.branch_id = :branchId"}
      ${branchFilter}

      GROUP BY c.id
      ORDER BY c."createdAt" DESC
    `, { replacements });

    if (!clients.length) {
      return res.status(404).json({
        success: false,
        message: "No client data"
      });
    }

    // ================= EXCEL =================
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Clients Report");

    // 🔥 TOP INFO (same as inventory)
    worksheet.addRow(["User Role:", role]);
    worksheet.addRow([
      "Branch Access:",
      isSuperUser ? "ALL BRANCHES" : userBranches.join(", ")
    ]);
    worksheet.addRow(["Generated At:", new Date().toLocaleString()]);
    worksheet.addRow([]);

    // 🔥 HEADER
    worksheet.columns = [
      { header: "Vendor Name", key: "vendorName", width: 25 },
      { header: "Email", key: "email", width: 30 },
      { header: "Phone", key: "phone", width: 20 },
      { header: "Total Amount", key: "totalAmount", width: 20 },
      { header: "Pending Amount", key: "pendingAmount", width: 20 },
      { header: "GST Number", key: "gstNumber", width: 25 }
    ];

    // 🔥 HEADER STYLE
    worksheet.getRow(5).font = { bold: true };

    // 🔥 DATA
    clients.forEach(c => {
      worksheet.addRow({
        vendorName: c.vendorName || "",
        email: c.email || "",
        phone: c.phone || "",
        totalAmount: c.totalAmount || 0,
        pendingAmount: c.pendingAmount || 0,
        gstNumber: c.gstNumber || ""
      });
    });

    // 🔥 TOTAL ROW
    const totalAmountSum = clients.reduce(
      (sum, c) => sum + Number(c.totalAmount || 0),
      0
    );

    const pendingAmountSum = clients.reduce(
      (sum, c) => sum + Number(c.pendingAmount || 0),
      0
    );

    worksheet.addRow([]);
    worksheet.addRow({
      vendorName: "TOTAL",
      totalAmount: totalAmountSum,
      pendingAmount: pendingAmountSum
    });

    // ================= DOWNLOAD =================
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename=clients-report-${Date.now()}.xlsx`
    );

    await workbook.xlsx.write(res);
    res.end();

  } catch (err) {
    console.error("❌ CLIENT EXPORT ERROR:", err);

    res.status(500).json({
      success: false,
      message: err.message
    });
  }
};