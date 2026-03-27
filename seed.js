// require("dotenv").config();
// const sequelize = require("./config/sqlcon");

// const { Role, User } = require("./model/SQL_Model");
// const bcrypt = require("bcrypt");

// const seedSuperUsers = async () => {
//   try {
//     console.log("🚀 Super Users seeding started...");

//     await sequelize.authenticate();
//     console.log("✅ DB Connected");

//     const data = [
//       {
//         role: "super_sales_manager",
//         email: "sales@super.com",
//         password: "123456"
//       },
//       {
//         role: "super_inventory_manager",
//         email: "inventory@super.com",
//         password: "123456"
//       }
//     ];

//     for (const item of data) {

//       // ================= ROLE =================
//       let role = await Role.findOne({ where: { name: item.role } });

//       if (!role) {
//         role = await Role.create({ name: item.role });
//         console.log(`✅ Role created: ${item.role}`);
//       } else {
//         console.log(`⚠️ Role exists: ${item.role}`);
//       }

//       // ================= USER =================
//       const existingUser = await User.findOne({ where: { email: item.email } });

//       if (existingUser) {
//         console.log(`⚠️ User already exists: ${item.email}`);
//         continue;
//       }

//       const hashedPassword = await bcrypt.hash(item.password, 10);

//       await User.create({
//         name: item.role,
//         email: item.email,
//         password: hashedPassword,
//         role_id: role.id
//       });

//       console.log(`✅ User created: ${item.email}`);
//     }

//     console.log("🎉 DONE (No data harmed 😎)");

//   } catch (error) {
//     console.error("❌ Error:", error.message);
//   } finally {
//     await sequelize.close();
//   }
// };

// seedSuperUsers();

const { ClientLedger } = require("./model/SQL_Model"); // path adjust karo
const clients = [
  { id: 114, branch_id: 7 },
  { id: 117, branch_id: 7 },
  { id: 230, branch_id: 11 },
  { id: 316, branch_id: 15 },
  { id: 320, branch_id: 15 },
  { id: 437, branch_id: 19 },
  { id: 438, branch_id: 19 },
  { id: 524, branch_id: 23 },
  { id: 525, branch_id: 23 },
  { id: 622, branch_id: 27 },
  { id: 624, branch_id: 27 },
  { id: 731, branch_id: 31 },
  { id: 732, branch_id: 31 },
  { id: 813, branch_id: 35 },
  { id: 814, branch_id: 35 },
  { id: 906, branch_id: 8 },
];

async function seedClientLedger() {
  try {
    const ledgerEntries = [];

    for (const client of clients) {
      for (let i = 0; i < 5; i++) {
        ledgerEntries.push({
          client_id: client.id,
          branch_id: client.branch_id,
          type: i % 2 === 0 ? "SALE" : "PAYMENT", // alternate SALE and PAYMENT
          invoice_no: `INV-${client.branch_id}-${client.id}-${i + 1}`,
          amount: Math.floor(Math.random() * 10000) + 100, // random 100-10000
          remark: i % 2 === 0 ? "Invoice" : "Payment",
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
    }

    await ClientLedger.bulkCreate(ledgerEntries);
    console.log("Client ledger seeded successfully!");
  } catch (error) {
    console.error("Error seeding client ledger:", error);
  }
}

// Run the seed
seedClientLedger();