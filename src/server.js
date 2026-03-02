const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3460;

app.use(express.static(path.join(__dirname, '..', 'web')));

app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'Ventusys' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'web', 'index.html')));

app.listen(PORT, () => console.log(`🚀 Ventusys on port ${PORT}`));
