const mongoose = require('mongoose');
require('dotenv').config();
require('./models/FacultyReport');
const FacultyReport = mongoose.model('FacultyReport');

mongoose.connect(process.env.MONGO_URI).then(async () => {
    const report = await FacultyReport.findOne({ driveLink: { $ne: '' } });
    if (report) {
        console.log('FOUND_LINK: ' + report.driveLink);
    } else {
        console.log('NO_LINK_FOUND');
    }
    process.exit(0);
}).catch(err => {
    console.error(err);
    process.exit(1);
});
