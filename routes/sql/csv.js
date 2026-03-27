const express = require("express");
const router = express.Router();

const auth = require("../../middleware/auth");
const checkRole = require("../../middleware/role");
const  exportcsv  = require("../../controllers/sqlbase/csvdownload");


router.get("/stock-aging/export", auth,exportcsv.exportStockAgingExcel);
router.get("/inventory/export-excel",auth,exportcsv.exportInventoryExcel);
router.get("/report/export-excel",auth,exportcsv.getReportsAnalyticsDashboard);
router.get("/ladger/export-excel",auth,exportcsv.exportClientsExcel);
module.exports = router;