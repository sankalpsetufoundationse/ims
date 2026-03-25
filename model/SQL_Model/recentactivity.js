const { DataTypes } = require("sequelize");
const sequelize = require("../../config/sqlcon");

const RecentActivity = sequelize.define(
  "RecentActivity",
  {
    user_id: {
      type: DataTypes.INTEGER,
      allowNull: true
    },

    action: {
      type: DataTypes.STRING,
      allowNull: false
    },

    details: {
      type: DataTypes.TEXT,
      allowNull: false
    },

    ref_id: {
      type: DataTypes.INTEGER,
      allowNull: true
    },

    ref_type: {
      type: DataTypes.STRING,
      allowNull: true
    }
  },
  {
    tableName: "recent_activities",
    underscored: true,
    timestamps: true
  }
);

module.exports = RecentActivity;