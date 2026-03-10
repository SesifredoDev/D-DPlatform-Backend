const jwt = require('jsonwebtoken');

module.exports = function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.sendStatus(401);

    const token = authHeader.split(' ')[1];
    if (!token) return res.sendStatus(401);

    jwt.verify(token, process.env.JWT_ACCESS_SECRET, (err, payload) => {
        if (err) {
            if (err.name === 'TokenExpiredError') {
                return res.sendStatus(401);  // <-- Change from 403 to 401 here
            }
            return res.sendStatus(403);
        }

        req.user = {
            id: payload.sub,
            email: payload.email,
            username: payload.username,
        };

        next();
    });
};
