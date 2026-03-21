const { DataTypes } = require("sequelize");
const sequelize = require("../../config/sqlcon");

const Invoice = sequelize.define("Invoice", {

  quotation_id: DataTypes.INTEGER,

  client_id: {
    type: DataTypes.INTEGER,
    allowNull: false
  },

  branch_id: {
    type: DataTypes.INTEGER,
    allowNull: false
  },

  invoice_no: {
    type: DataTypes.STRING,
    unique: true
  },

  total_amount: DataTypes.FLOAT,

  gst_amount: DataTypes.FLOAT,

  status: {
    type: DataTypes.ENUM(
      "draft",
      "final",
      "paid"
    ),
    defaultValue: "draft"
  }

}, {
  tableName: "invoices",
  timestamps: true
});

module.exports = Invoice;