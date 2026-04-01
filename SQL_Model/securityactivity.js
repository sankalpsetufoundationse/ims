const { DataTypes } = require("sequelize");
const sequelize = require("../../config/sqlcon");

const SecurityActivity = sequelize.define(
  "SecurityActivity",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true
    },

    user_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: "users",
        key: "id"
      }
    },

    activity_type: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "login"
    },

    device_name: {
      type: DataTypes.STRING,
      allowNull: true
    },

    ip_address: {
      type: DataTypes.STRING,
      allowNull: true
    },

    location: {
      type: DataTypes.STRING,
      allowNull: true
    },

    logged_in_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW
    }
  
  },
  {
    tableName: "security_activities",
    underscored: true,
    timestamps: true
  }
);

module.exports = SecurityActivity;