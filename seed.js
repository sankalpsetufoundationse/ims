require("dotenv").config();
const sequelize = require("./config/sqlcon");

const { Role, User } = require("./model/SQL_Model");
const bcrypt = require("bcrypt");

const seedSuperUsers = async () => {
  try {
    console.log("🚀 Super Users seeding started...");

    await sequelize.authenticate();
    console.log("✅ DB Connected");

    const data = [
      {
        role: "super_sales_manager",
        email: "sales@super.com",
        password: "123456"
      },
      {
        role: "super_inventory_manager",
        email: "inventory@super.com",
        password: "123456"
      }
    ];

    for (const item of data) {

      // ================= ROLE =================
      let role = await Role.findOne({ where: { name: item.role } });

      if (!role) {
        role = await Role.create({ name: item.role });
        console.log(`✅ Role created: ${item.role}`);
      } else {
        console.log(`⚠️ Role exists: ${item.role}`);
      }

      // ================= USER =================
      const existingUser = await User.findOne({ where: { email: item.email } });

      if (existingUser) {
        console.log(`⚠️ User already exists: ${item.email}`);
        continue;
      }

      const hashedPassword = await bcrypt.hash(item.password, 10);

      await User.create({
        name: item.role,
        email: item.email,
        password: hashedPassword,
        role_id: role.id
      });

      console.log(`✅ User created: ${item.email}`);
    }

    console.log("🎉 DONE (No data harmed 😎)");

  } catch (error) {
    console.error("❌ Error:", error.message);
  } finally {
    await sequelize.close();
  }
};

seedSuperUsers();