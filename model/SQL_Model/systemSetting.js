const { DataTypes } = require("sequelize");
const sequelize = require("../../config/sqlcon");

const SystemSetting = sequelize.define(
  "SystemSetting",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true
    },
    company_name: {
      type: DataTypes.STRING,
      allowNull: false
    },
    time_zone: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "Asia/Kolkata"
    },
    date_format: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "DD/MM/YYYY"
    },
    currency: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "INR"
    },
    created_by: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    updated_by: {
      type: DataTypes.INTEGER,
      allowNull: true
    }
  },
  {
    tableName: "system_settings",
    underscored: true,
    timestamps: true
  }
);

module.exports = SystemSetting;