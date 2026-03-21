const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phone: { type: String, required: true, unique: true }, 
  address: { type: String, required: true },
  image: { type: String, default: '' },
  CINnumber: { type: String, default: '' },
  branch: { type: String, required: true },
  location: { type: String, required: true },
  password: { type: String, required: true },
  role: {
    type: String,
    enum: ['superadmin', 'admin', 'user'],
    default: 'user'
  },
  isVerified: { type: Boolean, default: true }
}, { timestamps: true });

userSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
