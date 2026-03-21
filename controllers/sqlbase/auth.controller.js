// const { User, Role } = require("../../model/SQL_Model"); 
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");


const { User, Role, Branch } = require("../../model/SQL_Model");

exports.register = async (req, res) => {
  try {
    const { name, email, password, role_name, branch_id } = req.body;

    if (!name || !email || !password || !role_name) {
      return res.status(400).json({ error: "All fields required" });
    }

    const role = await Role.findOne({ where: { name: role_name } });
    if (!role) return res.status(400).json({ error: "Invalid role" });

    if (role_name !== "super_admin") {
      if (!branch_id) {
        return res.status(400).json({ error: "Branch required" });
      }

      const branchExists = await Branch.findByPk(branch_id);
      if (!branchExists) {
        return res.status(400).json({ error: "Invalid branch" });
      }
    }

    const exists = await User.findOne({ where: { email } });
    if (exists) return res.status(400).json({ error: "Email exists" });

    // 🔥 HASH PASSWORD
    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
      name,
      email,
      password: hashedPassword,
      role_id: role.id,
      branch_id: branch_id || null
    });

    res.status(201).json({
      message: "User registered",
      user
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email & password required" });
    }

    const user = await User.findOne({
      where: { email },
      include: {
        model: Role,
        as: "role",
        attributes: ["name"],
      },
    });

    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: "Account not active" });
    }

    // 🔐 PASSWORD CHECK (enable in production)
    // const match = await bcrypt.compare(password, user.password);
    // if (!match) {
    //   return res.status(401).json({ error: "Invalid password" });
    // }

    const roleName = user.role?.name;

   
    const superRoles = ["super_admin", "super_stock", "super_sales_manager","super_sales_manager","super_inventory_manager"];

    let branchIds = [];

   
    if (superRoles.includes(roleName)) {
      branchIds = ["ALL"]; 
    } else {
    
      try {
        const userBranches = await UserBranch.findAll({
          where: { user_id: user.id },
          attributes: ["branch_id"],
        });

        branchIds = userBranches.map(b => b.branch_id);

      } catch (err) {
        if (user.branch_id) {
          branchIds = [user.branch_id];
        }
      }

     
      if (!branchIds.length) {
        return res.status(403).json({
          error: "No branch assigned to user",
        });
      }
    }

   
    const token = jwt.sign(
      {
        id: user.id,
        role: roleName,
        branches: branchIds,
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: roleName,
        branches: branchIds,
      },
    });

  } catch (err) {
    console.error("LOGIN ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};

