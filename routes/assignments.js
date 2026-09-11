const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const Assignment = require('../models/Assignment');
const Class = require('../models/Class');
const jwt = require('jsonwebtoken');

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

// Multer Storage Configuration (Permanent Storage)
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'assignments',
    resource_type: 'auto'
  },
});

// Init Upload
const upload = multer({
    storage: storage,
    limits: { fileSize: 20000000 }, // 20MB limit
    fileFilter: function (req, file, cb) {
        checkFileType(file, cb);
    }
}).single('file');

// Check File Type
function checkFileType(file, cb) {
    const filetypes = /pdf|doc|docx|ppt|pptx|txt|png|jpg|jpeg|zip/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = filetypes.test(file.mimetype);

    if (mimetype || extname) {
        return cb(null, true);
    } else {
        cb('Error: Document or Archive files only!');
    }
}

// @route   POST api/assignments
// @desc    Create an assignment with file upload
// @access  Private (Teacher)
router.post('/', auth, (req, res) => {
    upload(req, res, async (err) => {
        if (err) {
            return res.status(400).json({ msg: err });
        }

        const { title, description, classId, deadline, marks, enableAI, submissionTypes } = req.body;
        const fileUrl = req.file ? req.file.path : null;

        let parsedSubmissionTypes = {
            code: false,
            output: false,
            image: false,
            pdf: false,
            zip: false
        };

        if (submissionTypes) {
            try {
                parsedSubmissionTypes = typeof submissionTypes === 'string' ? JSON.parse(submissionTypes) : submissionTypes;
            } catch (e) {
                console.error("Error parsing submissionTypes", e);
            }
        }

        try {
            const relatedClass = await Class.findById(classId);
            if (!relatedClass) return res.status(404).json({ msg: 'Class not found' });

            if (relatedClass.owner.toString() !== req.user.id && !relatedClass.teachers.includes(req.user.id)) {
                return res.status(403).json({ msg: 'Not authorized' });
            }

            const newAssignment = new Assignment({
                title,
                description,
                class: classId,
                deadline,
                marks,
                enableAI: enableAI === 'true',
                submissionTypes: parsedSubmissionTypes,
                fileUrl,
                createdBy: req.user.id
            });

            const savedAssignment = await newAssignment.save();
            res.json(savedAssignment);
        } catch (serverErr) {
            console.error(serverErr.message);
            res.status(500).send('Server Error');
        }
    });
});

// @route   GET api/assignments/class/:classId
// @desc    Get all assignments for a specific class
// @access  Private
router.get('/class/:classId', auth, async (req, res) => {
    try {
        const assignments = await Assignment.find({ class: req.params.classId }).sort({ createdAt: -1 });
        res.json(assignments);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET api/assignments/:id
// @desc    Get assignment by ID
// @access  Private
router.get('/:id', auth, async (req, res) => {
    try {
        const assignment = await Assignment.findById(req.params.id);
        if (!assignment) return res.status(404).json({ msg: 'Assignment not found' });
        res.json(assignment);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT api/assignments/:id
// @desc    Update assignment (title, description, marks, deadline, submissionTypes)
// @access  Private (Teacher)
router.put('/:id', auth, async (req, res) => {
    try {
        const assignment = await Assignment.findById(req.params.id);
        if (!assignment) return res.status(404).json({ msg: 'Assignment not found' });

        if (assignment.createdBy.toString() !== req.user.id) {
            return res.status(403).json({ msg: 'Not authorized' });
        }

        const { title, description, marks, deadline, submissionTypes } = req.body;

        if (title !== undefined) assignment.title = title;
        if (description !== undefined) assignment.description = description;
        if (marks !== undefined) assignment.marks = marks;
        if (deadline !== undefined) assignment.deadline = deadline;
        if (submissionTypes !== undefined) {
            const parsed = typeof submissionTypes === 'string' ? JSON.parse(submissionTypes) : submissionTypes;
            assignment.submissionTypes = { ...assignment.submissionTypes.toObject(), ...parsed };
        }

        await assignment.save();
        res.json(assignment);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT api/assignments/:id/publish-results
// @desc    Toggle resultsPublished
// @access  Private
router.put('/:id/publish-results', auth, async (req, res) => {
    try {
        const assignment = await Assignment.findById(req.params.id);
        if (!assignment) return res.status(404).json({ msg: 'Assignment not found' });

        if (assignment.createdBy.toString() !== req.user.id) {
            return res.status(403).json({ msg: 'Not authorized' });
        }

        assignment.resultsPublished = !assignment.resultsPublished;
        await assignment.save();
        res.json(assignment);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
