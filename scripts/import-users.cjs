const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { MongoClient } = require('mongodb');

dotenv.config();

const mongoUri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME || 'mr-bot';
const filePath = path.resolve(process.cwd(), process.argv[2] || 'users.json');

if (!mongoUri) {
  throw new Error('Missing MONGODB_URI in environment');
}

const normalizeUsername = (value) => String(value || '').trim().toLowerCase();
const DEFAULT_WORK_HOURS = {
  start: '09:00',
  end: '18:00',
  timezone: 'Europe/Moscow',
};

const parseUsers = (raw) => {
  const rows = JSON.parse(raw);
  if (!Array.isArray(rows)) {
    throw new Error('users file must contain an array');
  }

  return rows
    .map((item) => ({
      gitlabUsername: item.gitlabUsername,
      gitlabUsernameLower: normalizeUsername(item.gitlabUsername),
      ...(item.gitlabUserId ? { gitlabUserId: item.gitlabUserId } : {}),
      ...(item.telegramUsername ? { telegramUsername: item.telegramUsername } : {}),
      ...(item.telegramUsernameLower
        ? { telegramUsernameLower: normalizeUsername(item.telegramUsernameLower) }
        : item.telegramUsername
        ? { telegramUsernameLower: normalizeUsername(item.telegramUsername) }
        : {}),
      ...(item.telegramUserId ? { telegramUserId: item.telegramUserId } : {}),
      ...(item.chatId ? { chatId: item.chatId } : {}),
      ...(item.name ? { name: item.name } : {}),
      isAllowed: item.isAllowed !== false,
      ...(typeof item.isActive === 'boolean' ? { isActive: item.isActive } : { isActive: true }),
      ...(typeof item.isLead === 'boolean' ? { isLead: item.isLead } : {}),
      ...(typeof item.isReviewer === 'boolean'
        ? { isReviewer: item.isReviewer }
        : { isReviewer: true }),
      workHours: {
        start: item.workHours?.start || DEFAULT_WORK_HOURS.start,
        end: item.workHours?.end || DEFAULT_WORK_HOURS.end,
        timezone: item.workHours?.timezone || DEFAULT_WORK_HOURS.timezone,
      },
      ...(typeof item.ignoreWorkHours === 'boolean'
        ? { ignoreWorkHours: item.ignoreWorkHours }
        : {}),
    }))
    .filter((item) => item.gitlabUsername);
};

async function main() {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Users file not found: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const users = parseUsers(raw);
  if (!users.length) {
    throw new Error('No valid users found in input file');
  }

  const client = new MongoClient(mongoUri);
  await client.connect();

  try {
    const collection = client.db(dbName).collection('users');
    await collection.createIndex({ gitlabUsernameLower: 1 }, { unique: true });
    await collection.createIndex({ gitlabUserId: 1 }, { unique: true, sparse: true });
    await collection.createIndex({ telegramUsernameLower: 1 }, { unique: true, sparse: true });
    await collection.createIndex({ telegramUserId: 1 }, { unique: true, sparse: true });
    await collection.createIndex({ chatId: 1 }, { unique: true, sparse: true });

    for (const user of users) {
      await collection.updateOne(
        { gitlabUsernameLower: user.gitlabUsernameLower },
        {
          $set: {
            ...user,
            updatedAt: new Date(),
          },
          $setOnInsert: {
            createdAt: new Date(),
          },
        },
        { upsert: true },
      );
    }

    console.log(`Imported ${users.length} users into ${dbName}.users from ${filePath}`);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
