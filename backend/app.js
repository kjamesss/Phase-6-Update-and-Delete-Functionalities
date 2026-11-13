const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const path = require('node:path');
const { User, Task, Category } = require('./models');

function createApp(config) {
    const app = express();
    const origins = new Set(config.origins);
    app.disable('x-powered-by');
    app.use((req, res, next) => {
        const origin = req.get('Origin');
        if (origin && !origins.has(origin)) {
            return res.status(403).json({ message: 'This frontend origin is not allowed.' });
        }
        next();
    });
    app.use(cors({ origin: [...origins], credentials: true }));
    app.use(express.json({ limit: '20kb' }));
    app.use(cookieParser());
    app.use('/api', (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    });

    function signIn(res, user) {
        const token = jwt.sign({ sub: String(user._id) }, config.secret, { expiresIn: '8h' });
        res.cookie('bu_session', token, {
            httpOnly: true, sameSite: 'lax', secure: config.production,
            maxAge: 8 * 60 * 60 * 1000, path: '/'
        });
    }

    async function authenticated(req, res, next) {
        try {
            const payload = jwt.verify(req.cookies.bu_session || '', config.secret);
            req.user = await User.findById(payload.sub);
            if (!req.user) return res.status(401).json({ message: 'Log in to access your account.' });
            next();
        } catch (error) {
            if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
                return res.status(401).json({ message: 'Log in to access your account.' });
            }
            next(error);
        }
    }

    function validText(value, min, max) {
        return typeof value === 'string' && value.trim().length >= min && value.trim().length <= max;
    }

    function accountData(user) {
        return { _id: user._id, name: user.name, email: user.email, role: user.role, createdAt: user.createdAt };
    }

    function administrator(req, res, next) {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ message: 'An administrator account is required.' });
        }
        next();
    }

    app.get('/api/health', (req, res) => {
        const connected = mongoose.connection.readyState === 1;
        res.status(connected ? 200 : 503).json({ database: connected ? 'connected' : 'unavailable' });
    });

    app.post('/api/users', async (req, res) => {
        const { name, email, password } = req.body || {};
        if (!validText(name, 1, 100) || !validText(email, 3, 254) ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ||
            typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password) > 72) {
            return res.status(400).json({ message: 'Enter a name, valid email, and a password of 8 to 72 bytes.' });
        }
        const user = await User.create({
            name, email, passwordHash: await bcrypt.hash(password, 12), role: 'user'
        });
        signIn(res, user);
        res.status(201).json({ message: 'Account created successfully. You can now add a task.', user: accountData(user) });
    });

    app.post('/api/login', async (req, res) => {
        const { email, password } = req.body || {};
        if (!validText(email, 3, 254) || typeof password !== 'string' || Buffer.byteLength(password) > 72) {
            return res.status(400).json({ message: 'Enter your email and password.' });
        }
        const user = await User.findOne({ email: email.trim().toLowerCase() }).select('+passwordHash');
        if (!user || !await bcrypt.compare(password, user.passwordHash)) {
            return res.status(401).json({ message: 'Email or password is incorrect.' });
        }
        signIn(res, user);
        res.json({ message: 'Logged in successfully. You can now add a task.', user: accountData(user) });
    });

    app.post('/api/logout', (req, res) => {
        res.clearCookie('bu_session', { httpOnly: true, sameSite: 'lax', secure: config.production, path: '/' });
        res.json({ message: 'Logged out successfully.' });
    });

    app.get('/api/session', authenticated, (req, res) => {
        res.json({ user: accountData(req.user) });
    });

    app.get('/api/categories', authenticated, async (req, res) => {
        res.json({ categories: await Category.find({ owner: req.user._id }).sort({ name: 1 }).lean() });
    });

    app.get('/api/tasks', authenticated, async (req, res) => {
        const tasks = await Task.find({ owner: req.user._id })
            .populate({ path: 'category', select: 'name color', match: { owner: req.user._id } })
            .sort({ dueDate: 1, _id: 1 }).lean();
        res.json({ tasks });
    });

    app.get('/api/users', authenticated, administrator, async (req, res) => {
        const users = await User.find().select('name email role createdAt')
            .sort({ name: 1, _id: 1 }).lean();
        res.json({ users });
    });

    app.get('/api/admin/tasks', authenticated, administrator, async (req, res) => {
        const tasks = await Task.find().populate('owner', 'name')
            .sort({ dueDate: 1, _id: 1 }).lean();
        res.json({ tasks });
    });

    app.post('/api/categories', authenticated, async (req, res) => {
        const { name, color } = req.body || {};
        if (!validText(name, 1, 100) || (color && (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)))) {
            return res.status(400).json({ message: 'Enter a subject name and choose a valid display color.' });
        }
        const category = await Category.create({ name, color: color || undefined, owner: req.user._id });
        res.status(201).json({ message: 'Subject saved successfully.', category });
    });

    app.post('/api/tasks', authenticated, async (req, res) => {
        const { title, description = '', dueDate, status = 'To Do', priority = 'Medium', category } = req.body || {};
        const date = typeof dueDate === 'string' ? new Date(dueDate + 'T00:00:00.000Z') : new Date(NaN);
        const dateValid = /^\d{4}-\d{2}-\d{2}$/.test(dueDate) && Number.isFinite(date.valueOf()) &&
            date.toISOString().slice(0, 10) === dueDate;
        if (!validText(title, 1, 150) || typeof description !== 'string' || description.length > 2000 ||
            !dateValid || !['To Do', 'In Progress', 'Completed'].includes(status) ||
            !['Low', 'Medium', 'High'].includes(priority)) {
            return res.status(400).json({ message: 'Check the task title, valid due date, priority, status, and description.' });
        }
        if (category && (!mongoose.isObjectIdOrHexString(category) ||
            !await Category.exists({ _id: category, owner: req.user._id }))) {
            return res.status(400).json({ message: 'Choose a subject belonging to your account, or leave it uncategorized.' });
        }
        const task = await Task.create({
            title, description, dueDate: date, status, priority, category: category || null, owner: req.user._id
        });
        res.status(201).json({ message: 'Task saved successfully.', task });
    });

    app.use('/api', (req, res) => res.status(404).json({ message: 'API route not found.' }));
    app.use(express.static(path.join(__dirname, '../frontend')));

    app.use((error, req, res, next) => {
        if (error.code === 11000) return res.status(409).json({ message: 'This email is already registered. Log in or use another email.' });
        if (error.name === 'ValidationError' || error.name === 'CastError' || error.type === 'entity.parse.failed') {
            return res.status(400).json({ message: 'The submitted data is invalid. Check the fields and try again.' });
        }
        if (error.type === 'entity.too.large') return res.status(413).json({ message: 'The submitted data is too large.' });
        console.error('Request failed:', error.name);
        res.status(500).json({ message: 'Unable to complete the request. Please try again.' });
    });
    return app;
}

module.exports = { createApp };
