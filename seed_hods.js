require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("./models/User");

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/faculty_feedback";

const hods = [
  { name: "Dr. Abhishek Dixit",        email: "abhishekdixit@mitsgwalior.in",   department: "Centre for Computer Science and Technology",          designation: "HOD" },
  { name: "Dr. Anjali S Patil",         email: "anjalipatil@mitsgwalior.in",     department: "School of Architecture",                              designation: "HOD" },
  { name: "Dr. D.K. Jain",             email: "ain_dkj@mitsgwalior.in",         department: "School of Engineering Mathematics & Computing",        designation: "HOD" },
  { name: "Dr. Laxmi Shrivastava",     email: "lselex@mitsgwalior.in",          department: "School of Electronics and Communication Engineering",  designation: "HOD" },
  { name: "Dr. Pratesh Jayaswal",      email: "pratesh_jayaswal@mitsgwalior.in",department: "School of Mechanical Engineering",                     designation: "HOD" },
  { name: "Dr. Sanjay Tiwari",         email: "stiwari.fce@mitsgwalior.in",     department: "School of Civil Engineering",                         designation: "HOD" },
  { name: "Dr. Sanjeev Khanna",        email: "drkhannasanjeev@mitsgwalior.in", department: "School of Humanities and Management",                  designation: "HOD" },
  { name: "Dr. Vandana Vikas Thakare", email: "vandana@mitsgwalior.in",         department: "School of Electronics and Communication Engineering",  designation: "HOD" },
  { name: "Dr. Shishir Dixit",         email: "shishir.dixit1@mitsgwalior.in",  department: "School of Electrical Engineering",                    designation: "HOD" },
  { name: "Manish Dixit",              email: "dixitmits@mitsgwalior.in",       department: "Computer Science and Design",                         designation: "HOD" },
  { name: "Praveen Bansal",            email: "pbansal444@mitsgwalior.in",      department: "Centre for Internet of Things",                       designation: "HOD" },
  { name: "Punit Kumar Johari",        email: "pkjohari@mitsgwalior.in",        department: "School of Information Technology",                    designation: "HOD" },
  { name: "R R Singh",                 email: "rrsingh@mitsgwalior.in",         department: "Centre for Artificial Intelligence",                  designation: "HOD" },
  { name: "Shri Anish P. Jacob",       email: "anishjaco@mitsgwalior.in",       department: "School of Chemical Engineering",                      designation: "HOD" },
];

async function seedHODs() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("Connected to MongoDB:", MONGO_URI);
    const defaultPassword = "Mits@1234";
    const hashedPassword = await bcrypt.hash(defaultPassword, 10);
    let created = 0, skipped = 0;
    for (const hod of hods) {
      const existing = await User.findOne({ email: hod.email });
      if (existing) { console.log("Skipped:", hod.name, hod.email); skipped++; continue; }
      await User.create({ name: hod.name, email: hod.email, password: hashedPassword, role: "hod", department: hod.department, designation: hod.designation, status: "active" });
      console.log("Created:", hod.name, "--", hod.department);
      created++;
    }
    console.log("\nDone! Created:", created, "| Skipped:", skipped);
    console.log("Default password:", defaultPassword);
  } catch (err) {
    console.error("Error:", err.message);
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected.");
  }
}
seedHODs();
