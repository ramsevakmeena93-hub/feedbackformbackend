const { generateFeedbackReportPDF } = require('./services/pdfGenerator');
const fs = require('fs');

async function runTest() {
    const dummySubmission = {
        _id: 'TEST_ID',
        academicYear: '2025-26',
        session: 'jan-may',
        department: 'Computer Science',
        feedbackFormNo: 'I',
        submissionDate: new Date(),
        updatedAt: new Date()
    };

    const dummyReports = [
        {
            facultyName: 'TEST FACULTY',
            subjectCode: 'CS101-Batch-A',
            programme: 'B.Tech CSE',
            semester: '4',
            ffiScore: 4.5,
            responseCount: 50,
            commentsNeedingAttention: ['None'],
            appreciation: ['Excellent work!'],
            commentPercentages: { 'Excellent': 80, 'Good': 20 }
        },
        {
            facultyName: 'SECOND TEST',
            subjectCode: 'CS102-Batch-B',
            programme: 'B.Tech IT',
            semester: '4',
            ffiScore: 3.2,
            responseCount: 45,
            commentsNeedingAttention: ['Need more lab sessions'],
            appreciation: ['Nice teaching style'],
            commentPercentages: { 'Very Good': 50, 'Good': 30 }
        }
    ];

    try {
        const buf = await generateFeedbackReportPDF({
            submission: dummySubmission,
            reports: dummyReports,
            hodUser: { name: 'Test HOD', signatureImage: null },
            vcUser: { name: 'Test VC', signatureImage: null },
            approvedAt: new Date()
        });

        fs.writeFileSync('./test_report.pdf', buf);
        console.log('✓ SUCCESS! test_report.pdf has been generated.');
    } catch (err) {
        console.error('FAILED TO GENERATE TEST PDF:', err);
    }
}

runTest();
