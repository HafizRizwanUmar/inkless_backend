const express = require('express');
const router = express.Router();
const Quiz = require('../models/Quiz');
const QuizAttempt = require('../models/QuizAttempt');
const Class = require('../models/Class');
const jwt = require('jsonwebtoken');
const OpenAI = require('openai');

// ─── OpenAI Client ────────────────────────────────────────────────────────────
const getOpenAIClient = () => {
    if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY is not set in the environment.');
    }
    return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
};

// ─── Auth Middleware ──────────────────────────────────────────────────────────
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

// ─── Helper: Draw PDF Section Heading ─────────────────────────────────────────
const drawSectionHeading = (doc, text, color = '#1a1a2e') => {
    const y = doc.y;
    doc.rect(50, y, 495, 26).fill(color).fillColor('#fff')
        .font('Helvetica-Bold').fontSize(10)
        .text(text.toUpperCase(), 62, y + 8, { characterSpacing: 1 });
    doc.fillColor('#000').moveDown(0.2);
};

// ─── Helper: Draw Score Progress Bar ─────────────────────────────────────────
const drawScoreBar = (doc, score, total, color) => {
    const pct = total > 0 ? score / total : 0;
    const barX = 50, barY = doc.y, barW = 495, barH = 14;
    // Background
    doc.rect(barX, barY, barW, barH).fill('#e8e8e8');
    // Fill
    if (pct > 0) {
        doc.rect(barX, barY, Math.round(barW * pct), barH).fill(color);
    }
    // Label
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(8)
        .text(`${score}/${total}  (${Math.round(pct * 100)}%)`, barX + 6, barY + 3);
    doc.fillColor('#000').moveDown(1.2);
};

// ─── Helper: Draw Info Row ────────────────────────────────────────────────────
const drawInfoRow = (doc, label, value) => {
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#555').text(label, 50, doc.y, { continued: true, width: 130 });
    doc.font('Helvetica').fontSize(9).fillColor('#1a1a2e').text(value || '—', { align: 'left' });
    doc.moveDown(0.35);
};

// ─── Helper: Draw Divider ─────────────────────────────────────────────────────
const drawDivider = (doc, color = '#ddd') => {
    doc.moveDown(0.4);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor(color).lineWidth(0.5).stroke();
    doc.moveDown(0.6);
};

// ─── Generate Styled PDF Report ───────────────────────────────────────────────
const generateStyledPDF = (att, label, quiz) => {
    return new Promise((resolve, reject) => {
        const PDFDocument = require('pdfkit');
        const chunks = [];
        const doc = new PDFDocument({ margin: 0, size: 'A4' });
        doc.on('data', chunk => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const pct = att.totalPoints > 0 ? Math.round((att.score / att.totalPoints) * 100) : 0;

        // Color palette per category
        const palette = {
            Best:    { banner: '#1a6b3c', bar: '#27ae60', badge: '#d4edda', badgeText: '#155724', accent: '#27ae60' },
            Average: { banner: '#1a3c6b', bar: '#2980b9', badge: '#d0e8f8', badgeText: '#0c3b6e', accent: '#2980b9' },
            Worst:   { banner: '#6b1a1a', bar: '#c0392b', badge: '#fde8e8', badgeText: '#721c24', accent: '#c0392b' },
        };
        const p = palette[label] || palette['Average'];

        // ── Top Banner ──────────────────────────────────────────────────────
        doc.rect(0, 0, 595, 90).fill(p.banner);

        // Category badge
        doc.rect(430, 14, 130, 26).fill('#ffffff22');
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#fff')
            .text(label === 'Best' ? '🥇 BEST PERFORMER' : label === 'Worst' ? '🔴 NEEDS ATTENTION' : '🔵 CLASS AVERAGE',
                436, 21, { width: 120, align: 'center' });

        // Quiz title
        doc.font('Helvetica-Bold').fontSize(18).fillColor('#fff')
            .text(quiz.title || 'Quiz Report', 50, 20, { width: 370 });
        doc.font('Helvetica').fontSize(10).fillColor('#ffffffcc')
            .text('STUDENT PERFORMANCE REPORT  ·  INKLESS PLATFORM', 50, 44);

        // Generated date
        doc.font('Helvetica').fontSize(8).fillColor('#ffffff88')
            .text(`Generated: ${new Date().toLocaleString()}`, 50, 60);

        doc.y = 105;
        doc.x = 50;

        // ── Student Info Card ───────────────────────────────────────────────
        drawSectionHeading(doc, '  Student Information', '#2d2d2d');
        doc.moveDown(0.6);
        drawInfoRow(doc, 'STUDENT NAME', att.student?.name || 'Unknown');
        drawInfoRow(doc, 'EMAIL ADDRESS', att.student?.email || 'N/A');
        drawInfoRow(doc, 'SUBMISSION DATE', new Date(att.attemptedAt).toLocaleString());
        drawInfoRow(doc, 'QUIZ CATEGORY', label.toUpperCase());

        drawDivider(doc);

        // ── Score Summary Card ──────────────────────────────────────────────
        drawSectionHeading(doc, '  Score Summary', p.banner);
        doc.moveDown(0.7);

        // Big score display
        doc.font('Helvetica-Bold').fontSize(36).fillColor(p.accent)
            .text(`${pct}%`, 50, doc.y);
        doc.font('Helvetica').fontSize(13).fillColor('#555')
            .text(`${att.score} out of ${att.totalPoints} points`, 50, doc.y - 2);
        doc.moveDown(0.6);

        drawScoreBar(doc, att.score, att.totalPoints, p.bar);

        // Grade letter
        const grade = pct >= 90 ? 'A+' : pct >= 80 ? 'A' : pct >= 70 ? 'B' : pct >= 60 ? 'C' : pct >= 50 ? 'D' : 'F';
        const gradeColor = pct >= 70 ? '#27ae60' : pct >= 50 ? '#e67e22' : '#c0392b';
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#555').text('GRADE:  ', 50, doc.y, { continued: true });
        doc.fillColor(gradeColor).text(grade);
        doc.moveDown(0.4);

        drawDivider(doc);

        // ── Academic Integrity ──────────────────────────────────────────────
        const strikes = att.strikes || 0;
        const integrityColor = strikes === 0 ? '#1a6b3c' : strikes < 3 ? '#7d4e00' : '#6b1a1a';
        drawSectionHeading(doc, '  Academic Integrity Report', integrityColor);
        doc.moveDown(0.6);

        const integrityStatus = strikes === 0 ? '✓ CLEAN — No violations detected' : strikes < 3 ? '⚠ CAUTION — Minor violations noted' : '✗ FLAGGED — Multiple violations';
        doc.font('Helvetica-Bold').fontSize(10).fillColor(integrityColor).text(integrityStatus, 50, doc.y);
        doc.moveDown(0.5);
        drawInfoRow(doc, 'TAB SWITCHES', String(att.tabSwitchCount || 0));
        drawInfoRow(doc, 'COPY ATTEMPTS', String(att.copyAttemptCount || 0));
        drawInfoRow(doc, 'TOTAL STRIKES', String(strikes));

        drawDivider(doc);

        // ── Answer Breakdown ─────────────────────────────────────────────────
        drawSectionHeading(doc, '  Answer Breakdown', '#2d2d2d');
        doc.moveDown(0.7);

        att.answers.forEach((ans, i) => {
            // Check page break
            if (doc.y > 700) {
                doc.addPage();
                doc.y = 50;
            }

            const qNum = ans.questionIndex + 1;
            const question = quiz.questions?.[ans.questionIndex];

            // Question number pill
            const pillY = doc.y;
            doc.rect(50, pillY, 28, 14).fill(p.accent);
            doc.font('Helvetica-Bold').fontSize(7).fillColor('#fff')
                .text(`Q${qNum}`, 52, pillY + 3, { width: 24, align: 'center' });

            // Question text (truncated)
            if (question?.questionText) {
                doc.font('Helvetica').fontSize(9).fillColor('#333')
                    .text(question.questionText.substring(0, 120) + (question.questionText.length > 120 ? '...' : ''), 85, pillY, { width: 460 });
            } else {
                doc.font('Helvetica').fontSize(9).fillColor('#999')
                    .text(`Question ${qNum}`, 85, pillY);
            }
            doc.moveDown(0.3);

            // Answer
            if (ans.selectedOptionIndex !== undefined) {
                const optLetter = String.fromCharCode(65 + ans.selectedOptionIndex);
                doc.font('Helvetica-Bold').fontSize(8).fillColor('#555').text('  SELECTED:', 65, doc.y, { continued: true });
                doc.font('Helvetica').fillColor('#1a1a2e').text(`  Option ${optLetter}`);
            } else if (ans.textAnswer) {
                doc.font('Helvetica-Bold').fontSize(8).fillColor('#555').text('  ANSWER:', 65, doc.y);
                doc.font('Helvetica').fontSize(8).fillColor('#1a1a2e')
                    .text(`  "${ans.textAnswer.substring(0, 250)}${ans.textAnswer.length > 250 ? '...' : ''}"`,
                        65, doc.y, { width: 470 });
            } else {
                doc.font('Helvetica').fontSize(8).fillColor('#999').text('  (No answer submitted)', 65, doc.y);
            }
            doc.moveDown(0.3);

            // AI Feedback
            if (ans.aiFeedback) {
                const fbY = doc.y;
                doc.rect(65, fbY, 475, 1).fill('#ddd'); // top border
                doc.moveDown(0.15);
                doc.rect(65, doc.y, 3, 20).fill(p.accent); // left accent bar
                doc.font('Helvetica-Bold').fontSize(7.5).fillColor(p.accent)
                    .text('  AI FEEDBACK:', 72, doc.y, { continued: true });
                doc.font('Helvetica').fontSize(7.5).fillColor('#444')
                    .text(`  ${ans.aiFeedback}`, { width: 455 });
                doc.moveDown(0.3);
            }

            doc.moveDown(0.4);
        });

        // ── Footer ───────────────────────────────────────────────────────────
        const pageCount = doc.bufferedPageRange().count;
        for (let i = 0; i < pageCount; i++) {
            doc.switchToPage(i);
            doc.rect(0, 810, 595, 32).fill('#1a1a2e');
            doc.font('Helvetica').fontSize(7).fillColor('#ffffff66')
                .text('Generated by Inkless · Academic Management Platform · Confidential',
                    50, 820, { width: 495, align: 'center' });
        }

        doc.end();
    });
};

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// @route   POST api/quizzes/generate
// @desc    Generate quiz questions using OpenAI ChatGPT
// @access  Private (Teacher)
router.post('/generate', auth, async (req, res) => {
    const { material, numQuestions, types } = req.body;
    if (!material) return res.status(400).json({ msg: 'Material text is required for generation.' });

    try {
        const openai = getOpenAIClient();
        const prompt = `
You are an expert teacher creating a quiz based on the following material:
---
${material}
---

Create exactly ${numQuestions || 5} questions of the following types: ${types ? types.join(', ') : 'MCQ, SHORT, LONG'}.

Return ONLY a valid JSON array of objects representing the questions. DO NOT include any markdown formatting like \`\`\`json.
Each object must follow this exact structure according to its type:

For 'MCQ':
{
  "type": "MCQ",
  "questionText": "The question...?",
  "options": [
    {"text": "Option A"},
    {"text": "Option B"},
    {"text": "Option C"},
    {"text": "Option D"}
  ],
  "correctOptionIndex": 0,
  "points": 1
}

For 'SHORT' or 'LONG':
{
  "type": "SHORT",
  "questionText": "The question...?",
  "points": 5
}
`;
        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            response_format: { type: 'json_object' }
        });

        let textResult = completion.choices[0].message.content.trim();
        let parsed = JSON.parse(textResult);
        // Handle wrapped responses like { "questions": [...] }
        if (parsed.questions) parsed = parsed.questions;
        else if (!Array.isArray(parsed)) {
            // Try to find any array value
            const firstArr = Object.values(parsed).find(v => Array.isArray(v));
            if (firstArr) parsed = firstArr;
        }

        res.json(parsed);
    } catch (err) {
        console.error('AI Generation Error:', err.message);
        res.status(500).json({ msg: 'Failed to generate quiz with AI', error: err.message });
    }
});

// @route   POST api/quizzes
// @desc    Create a quiz
// @access  Private (Teacher)
router.post('/', auth, async (req, res) => {
    const { title, description, classId, questions, timeLimitMinutes, startTime, endTime } = req.body;
    try {
        const relatedClass = await Class.findById(classId);
        if (!relatedClass) return res.status(404).json({ msg: 'Class not found' });
        if (relatedClass.owner.toString() !== req.user.id && !relatedClass.teachers.includes(req.user.id)) {
            return res.status(403).json({ msg: 'Not authorized to create quiz for this class' });
        }
        const newQuiz = new Quiz({
            title, description, class: classId, questions,
            createdBy: req.user.id,
            timeLimitMinutes: timeLimitMinutes || null,
            startTime: startTime || null,
            endTime: endTime || null
        });
        const savedQuiz = await newQuiz.save();
        res.json(savedQuiz);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET api/quizzes/class/:classId
// @desc    Get all quizzes for a specific class
// @access  Private
router.get('/class/:classId', auth, async (req, res) => {
    try {
        const quizzes = await Quiz.find({ class: req.params.classId }).sort({ createdAt: -1 });
        res.json(quizzes);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST api/quizzes/attempt
// @desc    Submit a quiz attempt
// @access  Private (Student)
router.post('/attempt', auth, async (req, res) => {
    const { quizId, answers } = req.body;
    try {
        const quiz = await Quiz.findById(quizId);
        if (!quiz) return res.status(404).json({ msg: 'Quiz not found' });

        const existingAttempt = await QuizAttempt.findOne({ quiz: quizId, student: req.user.id });
        if (existingAttempt) return res.status(400).json({ msg: 'You have already attempted this quiz' });

        let score = 0;
        let totalPoints = 0;

        for (let index = 0; index < quiz.questions.length; index++) {
            const question = quiz.questions[index];
            totalPoints += question.points || 1;
            const studentAnswer = answers.find(a => a.questionIndex === index);
            if (studentAnswer && (question.type === 'MCQ' || !question.type)) {
                if (studentAnswer.selectedOptionIndex === question.correctOptionIndex) {
                    score += question.points || 1;
                }
            }
        }

        const attempt = new QuizAttempt({
            quiz: quizId,
            student: req.user.id,
            answers, score, totalPoints,
            strikes: req.body.strikes || 0,
            tabSwitchCount: req.body.tabSwitchCount || 0,
            copyAttemptCount: req.body.copyAttemptCount || 0
        });

        const savedAttempt = await attempt.save();
        res.json({ ...savedAttempt.toObject(), resultsShared: quiz.resultsShared });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET api/quizzes/attempt/:quizId
// @desc    Get user's attempt for a specific quiz (includes resultsShared from quiz)
// @access  Private
router.get('/attempt/:quizId', auth, async (req, res) => {
    try {
        const attempt = await QuizAttempt.findOne({ quiz: req.params.quizId, student: req.user.id });
        if (!attempt) return res.status(404).json({ msg: 'No attempt found' });
        // Include resultsShared so the student result screen knows whether to show AI feedback
        const quiz = await Quiz.findById(req.params.quizId).select('resultsShared');
        res.json({ ...attempt.toObject(), resultsShared: quiz?.resultsShared || false });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET api/quizzes/submissions/:quizId
// @desc    Get ALL student attempts for a quiz (Teacher only)
// @access  Private (Teacher)
router.get('/submissions/:quizId', auth, async (req, res) => {
    try {
        const quiz = await Quiz.findById(req.params.quizId);
        if (!quiz) return res.status(404).json({ msg: 'Quiz not found' });

        const relatedClass = await Class.findById(quiz.class);
        if (!relatedClass) return res.status(404).json({ msg: 'Class not found' });
        if (relatedClass.owner.toString() !== req.user.id && !relatedClass.teachers?.includes(req.user.id)) {
            return res.status(403).json({ msg: 'Not authorized' });
        }

        const attempts = await QuizAttempt.find({ quiz: req.params.quizId }).populate('student', 'name email');
        res.json({ quiz, attempts });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET api/quizzes/ai-status
// @desc    Check AI Availability (OpenAI)
// @access  Private (Teacher)
router.get('/ai-status', auth, async (req, res) => {
    try {
        const openaiAvailable = !!process.env.OPENAI_API_KEY;
        res.json({
            available: openaiAvailable,
            openai: openaiAvailable,
            primary: openaiAvailable ? 'OpenAI GPT-4o Mini' : 'Unavailable',
            msg: openaiAvailable ? 'OpenAI GPT-4o Mini is ready' : 'No AI API key configured'
        });
    } catch (err) {
        res.json({ available: false, msg: err.message });
    }
});

// @route   GET api/quizzes/:id
// @desc    Get quiz by ID
// @access  Private
router.get('/:id', auth, async (req, res) => {
    try {
        const quiz = await Quiz.findById(req.params.id);
        if (!quiz) return res.status(404).json({ msg: 'Quiz not found' });
        res.json(quiz);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET api/quizzes/export/excel/:quizId
// @desc    Export quiz submissions as Excel file (Teacher only)
// @access  Private (Teacher)
router.get('/export/excel/:quizId', auth, async (req, res) => {
    try {
        const XLSX = require('xlsx');
        const quiz = await Quiz.findById(req.params.quizId);
        if (!quiz) return res.status(404).json({ msg: 'Quiz not found' });

        const relatedClass = await Class.findById(quiz.class);
        if (!relatedClass || (relatedClass.owner.toString() !== req.user.id && !relatedClass.teachers?.includes(req.user.id))) {
            return res.status(403).json({ msg: 'Not authorized' });
        }

        const attempts = await QuizAttempt.find({ quiz: req.params.quizId })
            .populate('student', 'name email')
            .sort({ score: -1 });

        const rows = attempts.map((att, rank) => ({
            'Rank': rank + 1,
            'Student Name': att.student?.name || 'Unknown',
            'Email': att.student?.email || '',
            'Score': att.score,
            'Total Points': att.totalPoints,
            'Percentage': att.totalPoints > 0 ? `${Math.round((att.score / att.totalPoints) * 100)}%` : '0%',
            'Tab Switches': att.tabSwitchCount || 0,
            'Copy Attempts': att.copyAttemptCount || 0,
            'Total Strikes': att.strikes || 0,
            'Submitted At': new Date(att.attemptedAt).toLocaleString()
        }));

        const ws = XLSX.utils.json_to_sheet(rows);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Submissions');
        ws['!cols'] = [
            { wch: 6 }, { wch: 24 }, { wch: 30 }, { wch: 8 }, { wch: 12 },
            { wch: 12 }, { wch: 14 }, { wch: 15 }, { wch: 14 }, { wch: 22 }
        ];

        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        const safeName = quiz.title.replace(/[^a-z0-9]/gi, '_');
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}_submissions.xlsx"`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buf);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET api/quizzes/export/pdf-zip/:quizId
// @desc    Export best/average/worst student reports as a ZIP of beautiful styled PDFs
// @access  Private (Teacher)
router.get('/export/pdf-zip/:quizId', auth, async (req, res) => {
    try {
        const archiver = require('archiver');

        const quiz = await Quiz.findById(req.params.quizId);
        if (!quiz) return res.status(404).json({ msg: 'Quiz not found' });

        const relatedClass = await Class.findById(quiz.class);
        if (!relatedClass || (relatedClass.owner.toString() !== req.user.id && !relatedClass.teachers?.includes(req.user.id))) {
            return res.status(403).json({ msg: 'Not authorized' });
        }

        const attempts = await QuizAttempt.find({ quiz: req.params.quizId })
            .populate('student', 'name email')
            .sort({ score: -1 });

        if (attempts.length === 0) return res.status(404).json({ msg: 'No submissions to export.' });

        // Select best, average (closest to median), worst
        const best = attempts[0];
        const worst = attempts[attempts.length - 1];
        const midIdx = Math.floor(attempts.length / 2);
        const average = attempts[midIdx];

        // Generate all 3 styled PDFs in parallel
        const [bestPDF, avgPDF, worstPDF] = await Promise.all([
            generateStyledPDF(best, 'Best', quiz),
            generateStyledPDF(average, 'Average', quiz),
            generateStyledPDF(worst, 'Worst', quiz)
        ]);

        const safeName = quiz.title.replace(/[^a-z0-9]/gi, '_');
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}_reports.zip"`);
        res.setHeader('Content-Type', 'application/zip');

        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.on('error', err => { throw err; });
        archive.pipe(res);

        archive.append(bestPDF,  { name: `01_Best_${(best.student?.name || 'student').replace(/\s+/g, '_')}.pdf` });
        archive.append(avgPDF,   { name: `02_Average_${(average.student?.name || 'student').replace(/\s+/g, '_')}.pdf` });
        archive.append(worstPDF, { name: `03_Worst_${(worst.student?.name || 'student').replace(/\s+/g, '_')}.pdf` });

        await archive.finalize();
    } catch (err) {
        console.error(err.message);
        if (!res.headersSent) res.status(500).send('Server Error');
    }
});

// @route   POST api/quizzes/grade-all/:quizId
// @desc    Grade all text-based submissions using OpenAI ChatGPT
// @access  Private (Teacher)
router.post('/grade-all/:quizId', auth, async (req, res) => {
    try {
        const quiz = await Quiz.findById(req.params.quizId);
        if (!quiz) return res.status(404).json({ msg: 'Quiz not found' });

        const openai = getOpenAIClient();
        const attempts = await QuizAttempt.find({ quiz: req.params.quizId });
        if (attempts.length === 0) return res.status(400).json({ msg: 'No attempts to grade.' });

        let processedCount = 0;

        for (let attempt of attempts) {
            let totalNewScore = 0;
            let updated = false;

            for (let index = 0; index < quiz.questions.length; index++) {
                const question = quiz.questions[index];
                const studentAnswer = attempt.answers.find(a => a.questionIndex === index);
                if (!studentAnswer) continue;

                if (question.type === 'MCQ' || !question.type) {
                    if (studentAnswer.selectedOptionIndex === question.correctOptionIndex) {
                        totalNewScore += question.points || 1;
                    }
                } else if ((question.type === 'SHORT' || question.type === 'LONG') && studentAnswer.textAnswer) {
                    try {
                        const prompt = `
Question: ${question.questionText}
Max Points: ${question.points || 1}
Student Answer: ${studentAnswer.textAnswer}

Evaluate the student's answer. Return ONLY a valid JSON object with:
{
  "score": <number between 0 and Max Points based on correctness>,
  "feedback": "<1-2 sentences explaining why they got this score>"
}
`;
                        const completion = await openai.chat.completions.create({
                            model: 'gpt-4o-mini',
                            messages: [{ role: 'user', content: prompt }],
                            response_format: { type: 'json_object' }
                        });

                        const aiGrading = JSON.parse(completion.choices[0].message.content.trim());
                        studentAnswer.aiFeedback = aiGrading.feedback;
                        studentAnswer.manualScore = parseInt(aiGrading.score, 10) || 0;
                        totalNewScore += studentAnswer.manualScore;
                        updated = true;
                    } catch (e) {
                        console.error('AI Batch Grade Error:', e.message);
                    }
                }
            }

            if (updated) {
                attempt.score = totalNewScore;
                await attempt.save();
                processedCount++;
            }
        }

        res.json({ msg: `Successfully processed ${processedCount} attempts with OpenAI GPT-4o Mini.` });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST api/quizzes/share-results/:quizId
// @desc    Toggle result visibility for students
// @access  Private (Teacher)
router.post('/share-results/:quizId', auth, async (req, res) => {
    try {
        const quiz = await Quiz.findById(req.params.quizId);
        if (!quiz) return res.status(404).json({ msg: 'Quiz not found' });

        quiz.resultsShared = true;
        await quiz.save();

        const Notification = require('../models/Notification');
        const attempts = await QuizAttempt.find({ quiz: req.params.quizId });

        const notifications = attempts.map(att => ({
            recipient: att.student,
            sender: req.user.id,
            type: 'QUIZ',
            title: 'Quiz Results Shared',
            message: `Marks for "${quiz.title}" have been released by your teacher.`,
            link: `/student/quiz-attempt`
        }));

        if (notifications.length > 0) await Notification.insertMany(notifications);

        res.json({ msg: 'Results shared and notifications sent.' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT api/quizzes/attempt/:attemptId/manual-grade
// @desc    Manually grade a student's quiz attempt (per-question score + feedback)
// @access  Private (Teacher)
router.put('/attempt/:attemptId/manual-grade', auth, async (req, res) => {
    try {
        const attempt = await QuizAttempt.findById(req.params.attemptId);
        if (!attempt) return res.status(404).json({ msg: 'Attempt not found' });

        const quiz = await Quiz.findById(attempt.quiz);
        if (!quiz) return res.status(404).json({ msg: 'Quiz not found' });

        // grades: [{ questionIndex, score, feedback }]
        const { grades } = req.body;
        if (!grades || !Array.isArray(grades)) return res.status(400).json({ msg: 'grades array required' });

        let totalScore = 0;

        // Apply manual grades to each answer
        for (const grade of grades) {
            const ans = attempt.answers.find(a => a.questionIndex === grade.questionIndex);
            if (ans) {
                if (grade.score !== undefined) ans.manualScore = parseInt(grade.score, 10) || 0;
                if (grade.feedback !== undefined) ans.aiFeedback = grade.feedback;
            }
        }

        // Recalculate total score: use manualScore if set, else original scored points
        for (let i = 0; i < quiz.questions.length; i++) {
            const question = quiz.questions[i];
            const ans = attempt.answers.find(a => a.questionIndex === i);
            if (!ans) continue;
            if (ans.manualScore !== undefined) {
                totalScore += ans.manualScore;
            } else if (question.type === 'MCQ' || !question.type) {
                if (ans.selectedOptionIndex === question.correctOptionIndex) {
                    totalScore += question.points || 1;
                }
            }
        }

        attempt.score = totalScore;
        attempt.markModified('answers');
        await attempt.save();

        res.json({ msg: 'Grades saved successfully.', score: totalScore, attempt });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
