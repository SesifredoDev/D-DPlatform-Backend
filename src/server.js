require('dotenv').config();
const mongoose = require('mongoose');
const app = require('./app');

mongoose.connect(process.env.MONGO_URI).then(() => {
    app.listen(process.env.PORT, () =>
        console.log(`Auth server running on ${process.env.PORT}`)
    );
});
