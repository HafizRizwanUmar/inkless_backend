const dotenv = require('dotenv');
dotenv.config();
const mongoose = require('mongoose');

console.log('Connecting to:', process.env.MONGO_URI);

mongoose.connect(process.env.MONGO_URI).then(async () => {
    // List all collections
    const collections = await mongoose.connection.db.listCollections().toArray();
    console.log('Collections:', collections.map(c => c.name));

    // Raw query on assignments collection
    const raw = await mongoose.connection.db.collection('assignments').find({}).toArray();
    console.log('All assignments:');
    raw.forEach(a => console.log(' -', a.title, '| submissionTypes:', JSON.stringify(a.submissionTypes)));
    process.exit(0);
}).catch(err => { console.error(err); process.exit(1); });
