// const { User, Role } = require("../../model/SQL_Model"); 
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const { Op, fn, col, where } = require("sequelize");

const { User, Role, Branch,Notification,
  PasswordReset,
  RecentActivity } = require("../../model/SQL_Model");




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

    // ❌ inactive user block
    if (!user.is_active) {
      return res.status(403).json({ error: "Account not active" });
    }

    // 🔐 PASSWORD CHECK (ENABLE IN PROD)
    // const match = await bcrypt.compare(password, user.password);
    // if (!match) {
    //   return res.status(401).json({ error: "Invalid password" });
    // }

    const roleName = user.role?.name;

    const superRoles = [
      "super_admin",
      "super_stock",
      "super_sales_manager",
      "super_inventory_manager"
    ];

    let branchIds = [];

    // ✅ SUPER ROLE → ALL ACCESS
    if (superRoles.includes(roleName)) {
      branchIds = ["ALL"];
    } else {
      try {
        const userBranches = await UserBranch.findAll({
          where: { user_id: user.id },
          attributes: ["branch_id"],
        });

        branchIds = userBranches.map((b) => b.branch_id);

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

    // ✅ UPDATE LAST LOGIN
    await user.update({
      last_login: new Date()
    });

    // ✅ TOKEN
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
        lastLogin: user.last_login,   // 👈 optional return
      },
    });

  } catch (err) {
    console.error("LOGIN ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};


function generateOTP(length = 6) {
  let otp = "";
  for (let i = 0; i < length; i++) {
    otp += Math.floor(Math.random() * 10);
  }
  return otp;
}

function getApproverType(roleName) {
  if (roleName === "admin") {
    return "super_admin";
  }
  return "branch_admin";
}

async function getActiveSuperAdmins() {
  return User.findAll({
    where: { is_active: true },
    include: [
      {
        model: Role,
        as: "role",
        where: { name: "super_admin" },
        attributes: ["id", "name"]
      }
    ]
  });
}

async function getActiveBranchAdmins(branchId, excludeUserId = null) {
  const where = {
    is_active: true,
    branch_id: branchId
  };

  if (excludeUserId) {
    where.id = { [Op.ne]: excludeUserId };
  }

  return User.findAll({
    where,
    include: [
      {
        model: Role,
        as: "role",
        where: { name: "admin" },
        attributes: ["id", "name"]
      }
    ]
  });
}

async function createNotificationsForUsers(users, payloadBuilder) {
  if (!users || !users.length) return;

  const rows = users.map((user) => ({
    user_id: user.id,
    ...payloadBuilder(user)
  }));

  await Notification.bulkCreate(rows);
}

function uniqueUsersById(users = []) {
  const map = new Map();
  for (const user of users) {
    if (user && user.id) {
      map.set(user.id, user);
    }
  }
  return [...map.values()];
}

// =========================
// REQUEST PASSWORD RESET
// =========================
exports.requestPasswordReset = async (req, res) => {
  try {
    const email = req.body.email?.trim();

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required"
      });
    }

    const user = await User.findOne({
      where: {
        email: {
          [Op.iLike]: email
        }
      },
      include: [
        {
          model: Role,
          as: "role",
          attributes: ["id", "name"],
          required: false
        },
        {
          model: Branch,
          as: "branch",
          attributes: ["id", "name"],
          required: false
        }
      ]
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    if (!user.is_active) {
      return res.status(403).json({
        success: false,
        message: "User account is inactive"
      });
    }

    if (user.role?.name === "super_admin") {
      return res.status(400).json({
        success: false,
        message: "Super admin cannot use this reset flow"
      });
    }

    await PasswordReset.update(
      { status: "expired" },
      {
        where: {
          user_id: user.id,
          status: "pending",
          expires_at: {
            [Op.lt]: new Date()
          }
        }
      }
    );

    const existingPending = await PasswordReset.findOne({
      where: {
        user_id: user.id,
        status: "pending",
        expires_at: {
          [Op.gt]: new Date()
        }
      },
      order: [["createdAt", "DESC"]]
    });

    if (existingPending) {
      return res.status(400).json({
        success: false,
        message: "OTP already generated. Please contact approver."
      });
    }

    const otp = generateOTP(6);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const roleName = user.role?.name || "";
    const approverType = getApproverType(roleName);

    let approvers = [];
    let superAdmins = [];

    if (approverType === "super_admin") {
      approvers = await getActiveSuperAdmins();
      superAdmins = approvers;
    } else {
      approvers = await getActiveBranchAdmins(user.branch_id, user.id);
      superAdmins = await getActiveSuperAdmins();
    }

    if (!approvers.length) {
      return res.status(404).json({
        success: false,
        message:
          approverType === "super_admin"
            ? "No active super admin found"
            : "No active branch admin found for this branch"
      });
    }

    const resetRequest = await PasswordReset.create({
      user_id: user.id,
      branch_id: user.branch_id || null,
      otp,
      expires_at: expiresAt,
      status: "pending"
    });

    // OTP goes to actual approver
    await createNotificationsForUsers(approvers, () => ({
      title: "Password Reset OTP Request",
      message: `${user.name} (${user.email}) | Role: ${
        user.role?.name || "N/A"
      } | Branch: ${user.branch?.name || "N/A"} | OTP: ${otp}`,
      type: "password_reset_request"
    }));

    // Super admin visibility always
    const visibilityUsers = uniqueUsersById(superAdmins).filter(
      (sa) => !approvers.some((ap) => ap.id === sa.id)
    );

    await createNotificationsForUsers(visibilityUsers, () => ({
      title: "Password Reset Requested",
      message: `${user.name} (${user.email}) | Role: ${
        user.role?.name || "N/A"
      } | Branch: ${user.branch?.name || "N/A"} requested password reset.`,
      type: "password_reset_request_visibility"
    }));

    await RecentActivity.create({
      user_id: user.id,
      action: "PASSWORD_RESET_REQUESTED",
      details: `${user.name} (${user.email}) requested password reset. OTP sent to ${
        approverType === "super_admin" ? "super admin" : "branch admin"
      }.`,
      ref_id: resetRequest.id,
      ref_type: "password_reset"
    });

    return res.status(200).json({
      success: true,
      message:
        approverType === "super_admin"
          ? "OTP sent to super admin. Please contact super admin for OTP."
          : "OTP sent to your branch admin. Please contact branch admin for OTP."
    });
  } catch (error) {
    console.error("requestPasswordReset error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message
    });
  }
};

// =========================
// VERIFY OTP
// =========================
exports.verifyPasswordResetOTP = async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({
        success: false,
        message: "Email and OTP are required"
      });
    }

    const user = await User.findOne({
      where: {
        email: {
          [Op.iLike]: email.trim()
        }
      }
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    if (!user.is_active) {
      return res.status(403).json({
        success: false,
        message: "User account is inactive"
      });
    }

    const resetRequest = await PasswordReset.findOne({
      where: {
        user_id: user.id,
        otp: String(otp).trim(),
        status: "pending"
      },
      order: [["createdAt", "DESC"]]
    });

    if (!resetRequest) {
      return res.status(400).json({
        success: false,
        message: "Invalid OTP"
      });
    }

    if (new Date(resetRequest.expires_at) < new Date()) {
      resetRequest.status = "expired";
      await resetRequest.save();

      return res.status(400).json({
        success: false,
        message: "OTP expired"
      });
    }

    resetRequest.status = "verified";
    resetRequest.verified_at = new Date();
    await resetRequest.save();

    return res.status(200).json({
      success: true,
      message: "OTP verified successfully",
      reset_id: resetRequest.id
    });
  } catch (error) {
    console.error("verifyPasswordResetOTP error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message
    });
  }
};

// =========================
// RESET PASSWORD
// =========================
exports.resetPasswordWithOTP = async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;

    if (!email || !otp || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Email, OTP and newPassword are required"
      });
    }

    if (String(newPassword).trim().length < 6) {
      return res.status(400).json({
        success: false,
        message: "New password must be at least 6 characters"
      });
    }

    const user = await User.findOne({
      where: {
        email: {
          [Op.iLike]: email.trim()
        }
      },
      include: [
        {
          model: Role,
          as: "role",
          attributes: ["name"],
          required: false
        },
        {
          model: Branch,
          as: "branch",
          attributes: ["id", "name"],
          required: false
        }
      ]
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    if (!user.is_active) {
      return res.status(403).json({
        success: false,
        message: "User account is inactive"
      });
    }

    const resetRequest = await PasswordReset.findOne({
      where: {
        user_id: user.id,
        otp: String(otp).trim(),
        status: "verified"
      },
      order: [["createdAt", "DESC"]]
    });

    if (!resetRequest) {
      return res.status(400).json({
        success: false,
        message: "OTP not verified or invalid"
      });
    }

    if (new Date(resetRequest.expires_at) < new Date()) {
      resetRequest.status = "expired";
      await resetRequest.save();

      return res.status(400).json({
        success: false,
        message: "OTP expired"
      });
    }

    // password hash: model hook ya yahan bcrypt
    const hashedPassword = await bcrypt.hash(String(newPassword).trim(), 10);
    user.password = hashedPassword;

    // optional secure password update, only if your project uses encrypted/plain backup logic
    if ("secure_password" in user) {
      user.secure_password = null;
    }

    await user.save();

    resetRequest.status = "used";
    resetRequest.used_at = new Date();
    await resetRequest.save();

    const roleName = user.role?.name || "";
    const approverType = getApproverType(roleName);

    let approvers = [];
    let superAdmins = [];

    if (approverType === "super_admin") {
      approvers = await getActiveSuperAdmins();
      superAdmins = approvers;
    } else {
      approvers = await getActiveBranchAdmins(user.branch_id, user.id);
      superAdmins = await getActiveSuperAdmins();
    }

    // Completion notification to actual approver
    await createNotificationsForUsers(approvers, () => ({
      title: "Password Reset Completed",
      message: `${user.name} (${user.email}) | Role: ${
        user.role?.name || "N/A"
      } | Branch: ${user.branch?.name || "N/A"} has successfully reset password.`,
      type: "password_reset_done"
    }));

    // Super admin visibility always
    const visibilityUsers = uniqueUsersById(superAdmins).filter(
      (sa) => !approvers.some((ap) => ap.id === sa.id)
    );

    await createNotificationsForUsers(visibilityUsers, () => ({
      title: "Password Reset Completed",
      message: `${user.name} (${user.email}) | Role: ${
        user.role?.name || "N/A"
      } | Branch: ${user.branch?.name || "N/A"} has successfully reset password.`,
      type: "password_reset_done_visibility"
    }));

    await RecentActivity.create({
      user_id: user.id,
      action: "PASSWORD_RESET_COMPLETED",
      details: `${user.name} (${user.email}) reset password successfully.`,
      ref_id: resetRequest.id,
      ref_type: "password_reset"
    });

    return res.status(200).json({
      success: true,
      message: "Password reset successful"
    });
  } catch (error) {
    console.error("resetPasswordWithOTP error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message
    });
  }
};

// =========================
// MY NOTIFICATIONS
// =========================
exports.getMyNotifications = async (req, res) => {
  try {
    const notifications = await Notification.findAll({
      where: { user_id: req.user.id },
      order: [["createdAt", "DESC"]],
      limit: 20
    });

    return res.status(200).json({
      success: true,
      data: notifications
    });
  } catch (error) {
    console.error("getMyNotifications error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch notifications",
      error: error.message
    });
  }
};

exports.getRecentActivities = async (req, res) => {
  try {
    const activities = await RecentActivity.findAll({
      order: [["createdAt", "DESC"]],
      limit: 20
    });

    return res.status(200).json({
      success: true,
      data: activities
    });
  } catch (error) {
    console.error("getRecentActivities error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch recent activities",
      error: error.message
    });
  }
};

// =========================
// MARK NOTIFICATION READ
// =========================
exports.markNotificationRead = async (req, res) => {
  try {
    const { id } = req.params;

    const notification = await Notification.findOne({
      where: {
        id,
        user_id: req.user.id
      }
    });

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: "Notification not found"
      });
    }

    notification.is_read = true;
    await notification.save();

    return res.status(200).json({
      success: true,
      message: "Notification marked as read"
    });
  } catch (error) {
    console.error("markNotificationRead error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update notification",
      error: error.message
    });
  }
};
