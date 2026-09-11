const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const Submission = require('../models/Submission');
const Assignment = require('../models/Assignment');
const Class = require('../models/Class');
const jwt = require('jsonwebtoken');
const OpenAI = require('openai');
const fs = require('fs');
const pdfParse = require('pdf-parse');

const getOpenAIClient = () => {
    if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY is not set in the environment.');
    }
    return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
};

// Middleware to verify token
const auth = (req, res, next) => {
    const token = req.header('x-auth-token');
    if (!token) return res.status(401).json({ msg: 'No token, authorization denied' });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        req.user = decoded.user;
        next();
    } catch (e) {
        res.status(400).json({ msg: 'Token is not valid' });
    }
};

// Multer Config for Generic File Submissions (Images, PDF, ZIP)
const uploadDirSub = process.env.VERCEL ? '/tmp' : path.join(__dirname, '../public/uploads/submissions');
const fs = require('fs');
if (!process.env.VERCEL && !fs.existsSync(uploadDirSub)) {
    fs.mkdirSync(uploadDirSub, { recursive: true });
}

const storage = multer.diskStorage({
    destination: uploadDirSub,
    filename: function (req, file, cb) {
        cb(null, 'SUB-' + Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 20000000 }, // 20MB
    fileFilter: function (req, file, cb) {
        checkFileType(file, cb);
    }
}).single('file'); // Changed from 'image' to 'file'

function checkFileType(file, cb) {
    const filetypes = /jpeg|jpg|png|gif|pdf|zip/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = filetypes.test(file.mimetype);
    if (mimetype || extname) return cb(null, true);
    cb('Error: Only Images, PDF, or ZIP files are allowed!');
}

// @route   POST api/submissions
// @desc    Submit an assignment
// @access  Private (Student)
router.post('/', auth, (req, res) => {
    upload(req, res, async (err) => {
        if (err) return res.status(400).json({ msg: err });

        const { assignmentId, codeContent, outputContent, annotations } = req.body;
        const uploadedFile = req.file;

        try {
            const assignment = await Assignment.findById(assignmentId);
            if (!assignment) return res.status(404).json({ msg: 'Assignment not found' });

            // Validation: Ensure at least one required field is provided
            const types = assignment.submissionTypes || {};
            const hasFile = !!uploadedFile;
            const hasCode = !!codeContent && codeContent.trim().length > 0;
            const hasOutput = !!outputContent && outputContent.trim().length > 0;

            let isValid = false;
            if (types.code && hasCode) isValid = true;
            if (types.output && hasOutput) isValid = true;
            if ((types.pdf || types.zip || types.image) && hasFile) isValid = true;

            // Special case: if it's an update and they didn't upload a new file, but an old one exists
            let submission = await Submission.findOne({ assignment: assignmentId, student: req.user.id });
            if (submission && submission.filePath && (types.pdf || types.zip || types.image)) isValid = true;
            if (submission && submission.codeContent && types.code) isValid = true;
            if (submission && submission.outputContent && types.output) isValid = true;

            if (!isValid) {
                return res.status(400).json({ msg: 'Submission is empty or does not meet requirements.' });
            }

            const fileData = uploadedFile ? {
                filePath: `/uploads/submissions/${uploadedFile.filename}`,
                fileType: uploadedFile.mimetype.includes('pdf') ? 'pdf' : 
                          uploadedFile.mimetype.includes('zip') ? 'zip' : 'image'
            } : {};

            if (submission) {
                // Update
                submission.codeContent = codeContent !== undefined ? codeContent : submission.codeContent;
                submission.outputContent = outputContent !== undefined ? outputContent : submission.outputContent;
                submission.annotations = annotations ? JSON.parse(annotations) : submission.annotations;
                
                if (uploadedFile) {
                    submission.filePath = fileData.filePath;
                    submission.fileType = fileData.fileType;
                }
                
                submission.status = 'submitted';
                submission.submittedAt = Date.now();
                await submission.save();
                return res.json(submission);
            }

            // Create new
            const newSubmission = new Submission({
                assignment: assignmentId,
                student: req.user.id,
                codeContent,
                outputContent,
                annotations: annotations ? JSON.parse(annotations) : [],
                ...fileData
            });

            const savedSubmission = await newSubmission.save();
            res.json(savedSubmission);

        } catch (serverErr) {
            console.error(serverErr.message);
            res.status(500).send('Server Error');
        }
    });
});

// @route   GET api/submissions/assignment/:assignmentId
// @desc    Get all submissions for an assignment (Teacher view)
// @access  Private (Teacher)
router.get('/assignment/:assignmentId', auth, async (req, res) => {
    try {
        const assignment = await Assignment.findById(req.params.assignmentId);
        if (!assignment) return res.status(404).json({ msg: 'Assignment not found' });

        // Verify teacher
        const relatedClass = await Class.findById(assignment.class);
        const isTeacher = relatedClass.owner.toString() === req.user.id || relatedClass.teachers.includes(req.user.id);

        if (!isTeacher) return res.status(403).json({ msg: 'Not authorized' });

        const submissions = await Submission.find({ assignment: req.params.assignmentId })
            .populate('student', 'name email');

        res.json(submissions);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET api/submissions/my/:assignmentId
// @desc    Get my submission for an assignment (Student view)
// @access  Private
router.get('/my/:assignmentId', auth, async (req, res) => {
    try {
        const submission = await Submission.findOne({ assignment: req.params.assignmentId, student: req.user.id });
        if (!submission) return res.json(null); // No submission yet
        res.json(submission);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET api/submissions/:id
// @desc    Get single submission (Teacher view detail)
// @access  Private 
router.get('/:id', auth, async (req, res) => {
    try {
        const submission = await Submission.findById(req.params.id)
            .populate('student', 'name email')
            .populate('assignment');

        if (!submission) return res.status(404).json({ msg: 'Submission not found' });

        // Authorization check could be added here (ensure user is teacher of the class)

        res.json(submission);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST api/submissions/:id/ai-grade
// @desc    Grade a submission automatically using OpenAI
// @access  Private (Teacher)
router.post('/:id/ai-grade', auth, async (req, res) => {
    try {
        const submission = await Submission.findById(req.params.id).populate('assignment');
        if (!submission) return res.status(404).json({ msg: 'Submission not found' });

        // Verify teacher
        const relatedClass = await Class.findById(submission.assignment.class);
        if (!relatedClass) return res.status(404).json({ msg: 'Class not found' });
        const isTeacher = relatedClass.owner.toString() === req.user.id || relatedClass.teachers.includes(req.user.id);
        if (!isTeacher) return res.status(403).json({ msg: 'Not authorized' });

        const assignment = submission.assignment;
        let contentToEvaluate = '';

        if (submission.codeContent) {
            contentToEvaluate += `\n[Code Submission]:\n${submission.codeContent}`;
        }
        if (submission.outputContent) {
            contentToEvaluate += `\n[Output Log]:\n${submission.outputContent}`;
        }
        
        // Handle PDF parsing
        if (submission.filePath && submission.filePath.toLowerCase().endsWith('.pdf')) {
            try {
                const fullPath = path.join(__dirname, '..', submission.filePath);
                if (fs.existsSync(fullPath)) {
                    const dataBuffer = fs.readFileSync(fullPath);
                    const pdfData = await pdfParse(dataBuffer);
                    contentToEvaluate += `\n[PDF Document Content]:\n${pdfData.text}`;
                }
            } catch (err) {
                console.error('Error parsing PDF for AI:', err);
            }
        }

        if (!contentToEvaluate.trim()) {
            return res.status(400).json({ msg: 'No readable text/code content found in this submission for AI to evaluate.' });
        }

        const prompt = `
You are an expert Teacher Assistant grading an assignment.
Assignment Title: ${assignment.title}
Max Marks: ${assignment.marks || 100}
Assignment Description/Instructions:
${assignment.description}

Here is the student's submission:
${contentToEvaluate}

Evaluate the student's work strictly based on the assignment description. Return ONLY a valid JSON object with the following structure:
{
  "marks": <number between 0 and Max Marks representing the score>,
  "feedback": "<2-4 sentences of constructive feedback explaining the score>"
}
`;
        const openai = getOpenAIClient();
        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            response_format: { type: 'json_object' }
        });

        const aiResult = JSON.parse(completion.choices[0].message.content.trim());

        res.json({
            marks: aiResult.marks || 0,
            feedback: aiResult.feedback || 'Evaluated successfully by AI.'
        });

    } catch (err) {
        console.error('AI Grading Error:', err.message);
        res.status(500).json({ msg: err.message || 'Error processing AI evaluation' });
    }
});

// @route   POST api/submissions/:id/grade
// @desc    Grade a submission
// @access  Private (Teacher)
router.post('/:id/grade', auth, async (req, res) => {
    const { marks, feedback } = req.body;
    try {
        const submission = await Submission.findById(req.params.id).populate('assignment');
        if (!submission) return res.status(404).json({ msg: 'Submission not found' });

        // Verify teacher
        const relatedClass = await Class.findById(submission.assignment.class);
        const isTeacher = relatedClass.owner.toString() === req.user.id || relatedClass.teachers.includes(req.user.id);
        if (!isTeacher) return res.status(403).json({ msg: 'Not authorized' });

        submission.obtainedMarks = marks;
        submission.teacherFeedback = feedback;
        submission.status = 'graded';

        await submission.save();
        res.json(submission);

    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET api/submissions/teacher/pending
// @desc    Get all ungraded submissions for a teacher's classes
// @access  Private (Teacher)
router.get('/teacher/pending', auth, async (req, res) => {
    try {
        // Find all classes taught by this user
        const classes = await Class.find({ $or: [{ owner: req.user.id }, { teachers: req.user.id }] });
        const classIds = classes.map(c => c._id);

        // Find assignments in those classes
        const assignments = await Assignment.find({ class: { $in: classIds } });
        const assignmentIds = assignments.map(a => a._id);

        // Get submissions that are 'submitted' but not 'graded'
        const pendingSubmissions = await Submission.find({
            assignment: { $in: assignmentIds },
            status: { $ne: 'graded' }
        })
            .populate('student', 'name email')
            .populate('assignment', 'title deadline class')
            .sort({ submittedAt: 1 }); // Oldest first

        res.json(pendingSubmissions);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET api/submissions/student/pending
// @desc    Get all active assignments without a submission for the student
// @access  Private (Student)
router.get('/student/pending', auth, async (req, res) => {
    try {
        // Get all classes student is enrolled in
        const classes = await Class.find({ students: req.user.id });
        const classIds = classes.map(c => c._id);

        // Get ALL assignments for these classes
        const assignments = await Assignment.find({ class: { $in: classIds } });
        const assignmentIds = assignments.map(a => a._id);

        // Get all my submissions for these assignments
        const mySubmissions = await Submission.find({
            assignment: { $in: assignmentIds },
            student: req.user.id
        });

        const submittedAssignmentIds = mySubmissions.map(sub => sub.assignment.toString());

        // Filter assignments that have NO submission and deadline is in the future
        const now = new Date();
        const pendingAssignments = assignments.filter(a => {
            return !submittedAssignmentIds.includes(a._id.toString()) && new Date(a.deadline) > now;
        });

        res.json(pendingAssignments);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
