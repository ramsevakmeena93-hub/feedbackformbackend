const mongoose = require('mongoose');

/**
 * TeachingAssignment — records which subjects a faculty member (or HOD-as-faculty) teaches.
 * Kept COMPLETELY separate from roles so an HOD can teach subjects
 * across different branches / sections without changing their HOD role scope.
 *
 * Example: Prof. Sharma (HOD of CSE) also teaches "Data Structures" in
 * IT branch Section B — one TeachingAssignment captures that relationship.
 */
const teachingAssignmentSchema = new mongoose.Schema({
  /** The person who teaches (always a user with faculty or hod role) */
  facultyUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },

  /** Subject details — free-text to match existing FacultyReport fields */
  subjectCode:   { type: String, required: true },
  subjectName:   { type: String, default: '' },

  /** Branch / programme (e.g. "B.Tech CSE", "B.Tech IT") */
  programme:     { type: String, default: '' },
  branch:        { type: String, default: '' },
  section:       { type: String, default: '' },   // e.g. "A", "B"
  semester:      { type: String, default: '' },   // e.g. "5"
  academicYear:  { type: String, default: '' },   // e.g. "2024-2025"
  department:    { type: String, default: '' },   // owning department

  /** Active flag — deactivate without deleting historical records */
  active: { type: Boolean, default: true },

  /** Admin who created this assignment */
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

}, { timestamps: true });

// Prevent exact duplicates
teachingAssignmentSchema.index(
  { facultyUserId: 1, subjectCode: 1, branch: 1, section: 1, semester: 1, academicYear: 1 },
  { unique: true, sparse: true }
);

module.exports = mongoose.model('TeachingAssignment', teachingAssignmentSchema);
