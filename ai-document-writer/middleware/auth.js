// backend/middleware/auth.js
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const mysql = require('mysql2/promise');

// JWKS client for Azure AD token verification
const client = jwksClient({
  jwksUri: 'https://login.microsoftonline.com/15372935-df69-401a-8695-76ac8a4df2f5/discovery/v2.0/keys'
});

// Database connection
const dbConfig = {
  host: 'localhost',
  user: 'root',
  password: 'Pum35T12',
  database: 'chow',
  charset: 'utf8mb4'
};

// Get signing key
function getKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) {
      callback(err);
      return;
    }
    const signingKey = key.publicKey || key.rsaPublicKey;
    callback(null, signingKey);
  });
}

// Verify Azure AD token
const verifyAzureToken = (token) => {
  return new Promise((resolve, reject) => {
    jwt.verify(token, getKey, {
      audience: '4695596b-606c-415d-93eb-92879d6cea3d', // Your client ID
      issuer: 'https://login.microsoftonline.com/15372935-df69-401a-8695-76ac8a4df2f5/v2.0',
      algorithms: ['RS256']
    }, (err, decoded) => {
      if (err) {
        reject(err);
      } else {
        resolve(decoded);
      }
    });
  });
};

// Authentication middleware
const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      return res.status(401).json({ error: 'Access token required' });
    }

    // Verify the Azure AD token
    const decoded = await verifyAzureToken(token);
    
    // Get or create user in database
    const connection = await mysql.createConnection(dbConfig);
    
    try {
      // Check if user exists
      const [users] = await connection.execute(
        'SELECT * FROM users WHERE azure_id = ? OR email = ?',
        [decoded.oid || decoded.sub, decoded.email || decoded.preferred_username]
      );

      let user;
      if (users.length === 0) {
        // Create new user
        const userId = require('crypto').randomUUID();
        await connection.execute(
          `INSERT INTO users (id, azure_id, email, name, created_at, last_login) 
           VALUES (?, ?, ?, ?, NOW(), NOW())`,
          [
            userId,
            decoded.oid || decoded.sub,
            decoded.email || decoded.preferred_username,
            decoded.name || decoded.given_name + ' ' + decoded.family_name || 'Unknown User'
          ]
        );
        
        const [newUsers] = await connection.execute(
          'SELECT * FROM users WHERE id = ?',
          [userId]
        );
        user = newUsers[0];
      } else {
        // Update last login
        user = users[0];
        await connection.execute(
          'UPDATE users SET last_login = NOW() WHERE id = ?',
          [user.id]
        );
      }

      // Add user info to request
      req.user = {
        id: user.id,
        azureId: user.azure_id,
        email: user.email,
        name: user.name,
        subscriptionTier: user.subscription_tier
      };

      next();
    } finally {
      await connection.end();
    }

  } catch (error) {
    console.error('Authentication error:', error);
    res.status(403).json({ error: 'Invalid or expired token' });
  }
};

module.exports = { authenticateToken, dbConfig };