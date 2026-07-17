// ============================================================
// Backend do checkout PIX (SyncPay)
//
// Este servidor é o ÚNICO lugar que conhece a API Privada da
// SyncPay. Ela fica em variável de ambiente (.env / painel do
// Render), nunca no código, e nunca é enviada para o navegador
// do cliente.
//
// O front-end (index.html) só fala com este servidor, através
// de /api/pix/gerar e /api/pix/status/:id.
//
// Endpoints confirmados na documentação oficial da SyncPay
// (app.syncpayments.com.br > API > Documentação):
//   Base URL: https://api.syncpayments.com.br
//   POST /api/partner/v1/auth-token   -> gera o Bearer token (válido 1h)
//   POST /api/partner/v1/cash-in      -> gera a cobrança PIX
//   GET  /api/partner/v1/transaction/{identifier} -> status da transação
// ============================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors()); // em produção, restrinja para o domínio do seu site: cors({ origin: 'https://www.larissasecret.com' })
app.use(express.json());

const SYNCPAY_BASE_URL = process.env.SYNCPAY_BASE_URL || 'https://api.syncpayments.com.br';
const SYNCPAY_API_PUBLIC = process.env.SYNCPAY_API_PUBLIC;
const SYNCPAY_API_PRIVATE = process.env.SYNCPAY_API_PRIVATE;
const PRODUCT_NAME = process.env.PRODUCT_NAME || 'Conteudo Especial';
const PORT = process.env.PORT || 3000;

// ------------------------------------------------------------
// Planos de assinatura. O preço é definido AQUI, no servidor —
// nunca confie em um valor de preço enviado pelo navegador,
// porque ele pode ser alterado por quem estiver comprando
// (ex: via DevTools). O front-end só manda o "id" do plano
// escolhido (mensal/trimestral/anual), e o servidor consulta
// o preço real aqui.
// ------------------------------------------------------------
const PLANS = {
  mensal: { label: 'Plano Mensal', price: 19.99 },
  vitalicio: { label: 'Plano Vitalício', price: 34.99 },
  promo_hoje: { label: 'Promoção Hoje', price: 12.99 }
};

if (!SYNCPAY_API_PUBLIC || !SYNCPAY_API_PRIVATE) {
  console.error('ERRO: defina SYNCPAY_API_PUBLIC e SYNCPAY_API_PRIVATE (variaveis de ambiente)');
  process.exit(1);
}

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAuthToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt) {
    return cachedToken;
  }

  const res = await fetch(`${SYNCPAY_BASE_URL}/api/partner/v1/auth-token`, {
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

  cachedToken = data.access_token;
  const expiresInSeconds = data.expires_in || 3600;
  tokenExpiresAt = now + (expiresInSeconds - 60) * 1000;

  if (!cachedToken) {
    throw new Error('A SyncPay nao retornou um token de acesso.');
  }

  return cachedToken;
}

app.post('/api/pix/gerar', async (req, res) => {
  try {
    const { name, phone, cpf, plan } = req.body || {};

    if (!name || !phone || !cpf) {
      return res.status(400).json({ message: 'Nome, CPF e celular sao obrigatorios.' });
    }

    const selectedPlan = PLANS[plan];
    if (!selectedPlan) {
      return res.status(400).json({ message: 'Plano invalido.' });
    }

    const cpfDigits = cpf.replace(/\D/g, '');

    // A SyncPay exige um e-mail no cadastro, mas nao coletamos esse
    // dado do cliente no formulario. Geramos um e-mail tecnico
    // (nao é usado pra contato real, so preenche o campo obrigatorio
    // da API).
    const generatedEmail = `cliente-${cpfDigits}@checkout.larissasecret.com`;

    const token = await getAuthToken();

    const cashInRes = await fetch(`${SYNCPAY_BASE_URL}/api/partner/v1/cash-in`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        amount: selectedPlan.price,
        description: `${PRODUCT_NAME} - ${selectedPlan.label}`,
        client: {
          name,
          cpf: cpfDigits,
          email: generatedEmail,
          phone: phone.replace(/\D/g, '')
        }
      })
    });

    if (!cashInRes.ok) {
      const errText = await cashInRes.text().catch(() => '');
      console.error('Erro SyncPay /cash-in:', cashInRes.status, errText);
      return res.status(502).json({ message: 'Nao foi possivel gerar o PIX. Confira os dados e tente novamente.' });
    }

    const cashIn = await cashInRes.json();

    const qrCodeImage = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(cashIn.pix_code)}`;

    return res.json({
      chargeId: cashIn.identifier,
      qrCodeImage,
      copyPasteCode: cashIn.pix_code
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

    const statusRes = await fetch(`${SYNCPAY_BASE_URL}/api/partner/v1/transaction/${encodeURIComponent(chargeId)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!statusRes.ok) {
      return res.status(502).json({ message: 'Nao foi possivel consultar o status.' });
    }

    const body = await statusRes.json();
    const status = body && body.data ? body.data.status : undefined;

    const normalized =
      status === 'completed' ? 'paid' :
      status === 'expired' ? 'expired' :
      status === 'failed' ? 'failed' :
      'pending';

    return res.json({ status: normalized });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Erro interno ao consultar status.' });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
