require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

const SYNCPAY_BASE_URL = process.env.SYNCPAY_BASE_URL || 'https://api.syncpay.com.br';
const SYNCPAY_API_PUBLIC = process.env.SYNCPAY_API_PUBLIC;
const SYNCPAY_API_PRIVATE = process.env.SYNCPAY_API_PRIVATE;
const PRODUCT_PRICE = Number(process.env.PRODUCT_PRICE || 24.99);
const PRODUCT_NAME = process.env.PRODUCT_NAME || 'Album Premium';
const PORT = process.env.PORT || 3000;

if (!SYNCPAY_API_PUBLIC || !SYNCPAY_API_PRIVATE) {
  console.error('ERRO: defina SYNCPAY_API_PUBLIC e SYNCPAY_API_PRIVATE no ambiente');
  process.exit(1);
}

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAuthToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt) {
    return cachedToken;
  }

  const res = await fetch(`${SYNCPAY_BASE_URL}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: SYNCPAY_API_PUBLIC,
      client_secret: SYNCPAY_API_PRIVATE
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Falha ao autenticar na SyncPay (${res.status}): ${errText}`);
  }

  const data = await res.json();

  cachedToken = data.access_token || data.token;
  const expiresInSeconds = data.expires_in || 3600;
  tokenExpiresAt = now + (expiresInSeconds - 60) * 1000;

  if (!cachedToken) {
    throw new Error('A SyncPay nao retornou um token de acesso.');
  }

  return cachedToken;
}

app.post('/api/pix/gerar', async (req, res) => {
  try {
    const { name, phone } = req.body || {};

    if (!name || !phone) {
      return res.status(400).json({ message: 'Nome e celular sao obrigatorios.' });
    }

    const token = await getAuthToken();

    const chargeRes = await fetch(`${SYNCPAY_BASE_URL}/charges`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        amount: PRODUCT_PRICE,
        customer: {
          name,
          phone
        },
        items: [
          {
            title: PRODUCT_NAME,
            quantity: 1,
            unitPrice: PRODUCT_PRICE,
            tangible: false
          }
        ],
        pix: {
          expiresInDays: 1
        }
      })
    });

    if (!chargeRes.ok) {
      const errText = await chargeRes.text().catch(() => '');
      console.error('Erro SyncPay /charges:', chargeRes.status, errText);
      return res.status(502).json({ message: 'Nao foi possivel gerar o PIX. Tente novamente em instantes.' });
    }

    const charge = await chargeRes.json();

    return res.json({
      chargeId: charge.id || charge.charge_id,
      qrCodeImage: charge.qr_code_image || charge.qrCodeImage || charge.qrcode,
      copyPasteCode: charge.qr_code || charge.copyPasteCode || charge.pix_code
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Erro interno ao gerar o PIX.' });
  }
});

app.get('/api/pix/status/:chargeId', async (req, res) => {
  try {
    const { chargeId } = req.params;
    const token = await getAuthToken();

    const statusRes = await fetch(`${SYNCPAY_BASE_URL}/charges/${encodeURIComponent(chargeId)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!statusRes.ok) {
      return res.status(502).json({ message: 'Nao foi possivel consultar o status.' });
    }

    const data = await statusRes.json();

    return res.json({ status: data.status });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Erro interno ao consultar status.' });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
