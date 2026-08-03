const crypto = require('crypto');
const fs = require('fs');
const { pipeline } = require('stream/promises');

const MASTER_KEY_B64 = 'UIlTTEMmmLfGowo/UC60x2H45W6MdGgTRfo/umg4754=';

function decryptSecurityToken(securityTokenB64) {
  const masterKey = Buffer.from(MASTER_KEY_B64, 'base64');
  const securityToken = Buffer.from(securityTokenB64, 'base64');

  const iv = securityToken.subarray(0, 16);
  const encrypted = securityToken.subarray(16);

  const decipher = crypto.createDecipheriv('aes-256-cbc', masterKey, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

  const key = decrypted.subarray(0, 16);
  const nonce = decrypted.subarray(16, 24);
  return { key, nonce };
}

async function decryptFile(srcPath, destPath, key, nonce) {
  const iv = Buffer.concat([nonce, Buffer.alloc(8, 0)]);
  const decipher = crypto.createDecipheriv('aes-128-ctr', key, iv);
  await pipeline(fs.createReadStream(srcPath), decipher, fs.createWriteStream(destPath));
}

module.exports = { decryptSecurityToken, decryptFile };
