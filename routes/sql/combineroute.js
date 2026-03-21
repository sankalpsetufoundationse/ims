const express = require("express");
const router = express.Router();

const {
  getInventoryDashboard,
  getInventoryDashboardCharts,
  getBranchOverview,
  getBranchDashboard,
  getFullInventoryDashboard,
  getInventoryTable,
  getPurchaseSalesSummary,
  getPurchaseItems,
  getDamageStock,
  getAgingStock,
  getStockMovements,
  getStockAgingDashboard,
  getReportsAnalyticsDashboard,
  getCompleteDashboard
} = require("../../controllers/sqlbase/combine/combinemanager");

const auth = require("../../middleware/auth");
const checkRole = require("../../middleware/role");


// =====================================
// MAIN DASHBOARD
// =====================================

// Full dashboard (cards + charts + clients)
router.get(
  "/dashboard/complete",
  auth,
  checkRole(["stock_manager","inventory_manager"]),
  getCompleteDashboard
);


// Inventory dashboard
router.get(
  "/dashboard/inventory",
  auth,
  checkRole(["stock_manager","inventory_manager"]),
  getInventoryDashboard
);


// Dashboard charts
router.get(
  "/dashboard/charts",
  auth,
  checkRole(["stock_manager","inventory_manager"]),
  getInventoryDashboardCharts
);


// Full inventory dashboard (all branches)
router.get(
  "/dashboard/full",
  auth,
  checkRole(["inventory_manager","stock_manager"]),
  getFullInventoryDashboard
);



// Branch overview (all branches)
router.get(
  "/dashboard/branches",
  auth,
  checkRole(["inventory_manager","stock_manager"]),
  getBranchOverview
);


// Single branch dashboard
router.get(
  "/dashboard/branch/:branch",
  auth,
  checkRole(["stock_manager","inventory_manager"]),
  getBranchDashboard
);


// =====================================
// INVENTORY TABLE
// =====================================

router.get(
  "/inventory/table",
  auth,
  checkRole(["stock_manager","inventory_manager"]),
  getInventoryTable
);



router.get(
  "/inventory/purchase-sales-summary",
  auth,
  checkRole(["stock_manager","inventory_manager"]),
  getPurchaseSalesSummary
);


// Purchase items list
router.get(
  "/inventory/purchases",
  auth,
  checkRole(["stock_manager","inventory_manager"]),
  getPurchaseItems
);


// =====================================
// STOCK CONDITIONS
// =====================================

// Damaged stock
router.get(
  "/inventory/damaged",
  auth,
  checkRole(["stock_manager","inventory_manager"]),
  getDamageStock
);


// Aging stock
router.get(
  "/inventory/aging",
  auth,
  checkRole(["stock_manager","inventory_manager"]),
  getAgingStock
);


// Stock movement history
router.get(
  "/inventory/movements",
  auth,
  checkRole(["stock_manager","inventory_manager"]),
  getStockMovements
);


// =====================================
// ANALYTICS DASHBOARD
// =====================================

// Stock aging analytics dashboard
router.get(
  "/dashboard/aging",
  auth,
  checkRole(["stock_manager","inventory_manager","super_inventory_manager"]),
  getStockAgingDashboard
);


// Reports & analytics dashboard
router.get(
  "/dashboard/reports",
  auth,
  checkRole(["stock_manager","inventory_manager","super_inventory_manager"]),
  getReportsAnalyticsDashboard
);

module.exports = router;