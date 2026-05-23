const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const User = require('../models/User');

const USERS_TO_SETUP = [
  {
    name: "Dr. Anita Verma",
    email: "wegegjgdgdscg98@gmail.com",
    role: "hod",
    department: "Computer Science & Technology"
  },
  {
    name: "Tanuja Sharma",
    email: "tanuja.sharma@mits.ac.in",
    role: "faculty",
    department: "Computer Science & Technology"
  },
  {
    name: "ajaymeena",
    email: "ramsevakmeena93@gmail.com",
    role: "vc",
    department: "Computer Science & Technology"
  },
  {
    name: "System Admin",
    email: "admin@mits.ac.in",
    role: "admin",
    department: "Computer Science & Technology"
  }
];

async function run() {
  try {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/faculty_feedback');
    console.log('Connected to MongoDB');

    const hashedPassword = await bcrypt.hash('mits123', 10);

    for (const u of USERS_TO_SETUP) {
      const existing = await User.findOne({ email: u.email });
      if (existing) {
        // Update password and info
        existing.name = u.name;
        existing.password = hashedPassword;
        existing.department = u.department;
        existing.role = u.role;
        await existing.save();
        console.log(`Updated user: ${u.email} (${u.role}) with password 'mits123'`);
      } else {
        // Create new
        await User.create({
          name: u.name,
          email: u.email,
          password: hashedPassword,
          role: u.role,
          department: u.department
        });
        console.log(`Created user: ${u.email} (${u.role}) with password 'mits123'`);
      }
    }

    console.log('All default roles have been set up successfully!');
  } catch (err) {
    console.error('Error during setup:', err);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

run();
