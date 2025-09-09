import express from 'express';
import jwt from 'jsonwebtoken';
import { config } from 'dotenv';
import cors from 'cors';
import path from 'path';
import cookieParser from 'cookie-parser';
import serverless from 'serverless-http';
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
// REMOVED: import { GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';

config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const TABLE_NAME = process.env.TABLE_NAME;
const AWS_REGION = process.env.AWS_REGION || 'eu-central-1';

const ddbClient = new DynamoDBClient({ region: AWS_REGION });

// --- Middleware ---
app.use(cors());
app.use(cookieParser());
app.use(express.json());

// --- Authentication Middleware ---
async function checkAuthentication(req, res, next) {
  try {
    const accessToken = req.cookies.CF_Authorization;
    if (!accessToken || typeof accessToken !== 'string') {
      return res.status(401).json({ message: 'Authentication required: No token provided or invalid type.' });
    }

    const decoded = await jwt.decode(accessToken);
    if (!decoded || typeof decoded !== 'object') {
      return res.status(401).json({ message: 'Authentication failed: Invalid token structure.' });
    }

    req.user = decoded;
    req.username = decoded.custom?.family_name || 'unknown';
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Authentication failed: Invalid token.' });
  }
}

function parseYearMonth(queryYear, queryMonth) {
  const now = new Date();
  const year = !isNaN(parseInt(queryYear)) ? parseInt(queryYear) : now.getUTCFullYear();

  let startTimestamp, endTimestamp;
  if (!isNaN(parseInt(queryMonth)) && parseInt(queryMonth) >= 1 && parseInt(queryMonth) <= 12) {
    const month = parseInt(queryMonth) - 1;
    startTimestamp = Date.UTC(year, month, 1, 0, 0, 0);
    endTimestamp = Date.UTC(year, month + 1, 1, 0, 0, 0);
  } else {
    startTimestamp = Date.UTC(year, 0, 1, 0, 0, 0);
    endTimestamp = Date.UTC(year + 1, 0, 1, 0, 0, 0);
  }
  return { year, startTimestamp, endTimestamp };
}

function ymKeyParts(dateMs) {
  const d = new Date(dateMs);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const mm = String(m + 1).padStart(2, '0');
  return { year: y, month0: m, ym: `${y}-${mm}`, monthStartTs: Date.UTC(y, m, 1, 0, 0, 0) };
}

// --- Routes ---

app.get('/username', checkAuthentication, (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: 'User not authenticated.' });
  }
  res.json({ username: req.username });
});

// Liste der Messungen (optional nach Jahr/Monat)
app.get('/readings', checkAuthentication, async (req, res) => {
  try {
    const { startTimestamp, endTimestamp } = parseYearMonth(req.query.year, req.query.month);

    const command = new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'TimestampIndex',
      KeyConditionExpression: 'GlobalPK = :pk AND #ts BETWEEN :start AND :end',
      ExpressionAttributeNames: { '#ts': 'timestamp' },
      ExpressionAttributeValues: {
        ':pk': 'ALL_READINGS',
        ':start': startTimestamp,
        ':end': endTimestamp
      },
      ScanIndexForward: false
    });

    const result = await ddbClient.send(command);
    if (!result.Items) {
      return res.status(500).json({ message: 'Could not retrieve readings.' });
    }

    res.json(result.Items);
  } catch (error) {
    console.error('Error fetching readings:', error);
    res.status(500).json({ message: 'Error fetching readings', error: error.message });
  }
});

app.post('/readings', checkAuthentication, async (req, res) => {
  const { currentKWh, notes = '' } = req.body;
  const username = req.username;

  if (typeof currentKWh !== 'number' || !isFinite(currentKWh) || currentKWh <= 0) {
    return res.status(400).json({ message: 'Invalid or missing currentKWh value.' });
  }

  try {
    const lastResult = await ddbClient.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'TimestampIndex',
      KeyConditionExpression: 'GlobalPK = :pk',
      ExpressionAttributeValues: { ':pk': 'ALL_READINGS' },
      ScanIndexForward: false,
      Limit: 1,
    }));

    const lastReading = lastResult.Items?.[0];
    const startKWh = typeof lastReading?.endKWh === 'number' ? lastReading.endKWh : 0;
    const endKWh = currentKWh;
    const deltaKWh = parseFloat((endKWh - startKWh).toFixed(3));

    if (deltaKWh <= 0) {
      return res.status(400).json({
        message: `currentKWh (${endKWh}) must be greater than the last recorded endKWh (${startKWh}).`
      });
    }

    const now = Date.now();
    const { ym, monthStartTs } = ymKeyParts(now);

    const reading = {
      washId: uuidv4(),
      username,
      startKWh,
      endKWh,
      deltaKWh,
      notes,
      timestamp: now,
      GlobalPK: 'ALL_READINGS'
    };

    await ddbClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: reading
    }));

    return res.status(201).json({ reading });

  } catch (error) {
    console.error('Error saving reading:', error);
    return res.status(500).json({ message: 'Error saving reading', error: error.message });
  }
});

// Letzter Zählerstand
app.get('/latest-kwh', checkAuthentication, async (req, res) => {
  try {
    const query = new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'TimestampIndex',
      KeyConditionExpression: 'GlobalPK = :pk',
      ExpressionAttributeValues: { ':pk': 'ALL_READINGS' },
      ScanIndexForward: false,
      Limit: 1,
    });

    const result = await ddbClient.send(query);
    const last = result.Items?.[0];

    res.json({ latestEndKWh: last?.endKWh ?? 0 });
  } catch (error) {
    console.error('Error fetching last kWh:', error);
    res.status(500).json({ message: 'Error fetching last kWh', error: error.message });
  }
});


// Statische Files
app.use('/', checkAuthentication, express.static(path.join(__dirname, 'public', 'home')));

app.use((req, res) => {
  if (!req.path.includes('.')) {
    res.sendFile(path.join(__dirname, 'public', 'home', 'index.html'));
  } else {
    res.status(404).send('Not Found');
  }
});

export const handler = serverless(app, {
  request: (req, event) => {
    if (event.body && typeof event.body === 'string') {
      const isBase64 = event.isBase64Encoded;
      try {
        const decoded = isBase64
          ? Buffer.from(event.body, 'base64').toString()
          : event.body;
        req.body = JSON.parse(decoded);
      } catch (e) {
        console.error('Body parse error:', e.message);
        req.body = {};
      }
    }
  }
});