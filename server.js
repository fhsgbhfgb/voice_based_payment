// server.js - Cashfree Payment Backend
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Enable CORS for local testing
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Cashfree Configuration
const CASHFREE_APP_ID = process.env.CASHFREE_APP_ID;
const CASHFREE_SECRET_KEY = process.env.CASHFREE_SECRET_KEY;
const CASHFREE_API_VERSION = '2023-08-01';

// IMPORTANT: Check if credentials exist
if (!CASHFREE_APP_ID || !CASHFREE_SECRET_KEY) {
    console.error('❌ CASHFREE_APP_ID or CASHFREE_SECRET_KEY not found in .env file!');
    console.error('Please create a .env file with your Cashfree credentials');
}

// Use production for live mode
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const CASHFREE_BASE_URL = IS_PRODUCTION
    ? 'https://api.cashfree.com/pg'
    : 'https://sandbox.cashfree.com/pg';

// API: Create Cashfree Order
app.post('/api/create-order', async (req, res) => {
    try {
        const { amount, upiId, customerName, customerPhone, customerEmail } = req.body;

        // Validate
        if (!amount || amount <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid amount' });
        }

        if (!CASHFREE_APP_ID || !CASHFREE_SECRET_KEY) {
            return res.status(500).json({ 
                success: false, 
                error: 'Cashfree credentials not configured' 
            });
        }

        // Generate unique order ID
        const orderId = 'ORDER_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        const customerId = 'CUST_' + Date.now();

        // Get the correct return URL
        const baseUrl = req.get('host').includes('localhost') 
            ? `http://${req.get('host')}`
            : `https://${req.get('host')}`;

        // Cashfree Order Request - CORRECTED FORMAT
        const orderData = {
            order_id: orderId,
            order_amount: parseFloat(amount).toFixed(2),
            order_currency: 'INR',
            customer_details: {
                customer_id: customerId,
                customer_name: customerName || 'Customer',
                customer_email: customerEmail || 'customer@example.com',
                customer_phone: customerPhone || '9999999999'
            },
            order_meta: {
                return_url: `${baseUrl}/payment-response?order_id=${orderId}`,
                notify_url: `${baseUrl}/api/webhook`
            }
        };

        console.log('📝 Creating Cashfree order:', {
            url: `${CASHFREE_BASE_URL}/orders`,
            orderId: orderId,
            amount: orderData.order_amount,
            mode: IS_PRODUCTION ? '🔴 PRODUCTION' : '🟡 SANDBOX',
            returnUrl: orderData.order_meta.return_url
        });

        // Call Cashfree API with correct headers
        const response = await axios.post(
            `${CASHFREE_BASE_URL}/orders`,
            orderData,
            {
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'x-api-version': CASHFREE_API_VERSION,
                    'x-client-id': CASHFREE_APP_ID,
                    'x-client-secret': CASHFREE_SECRET_KEY
                }
            }
        );

        console.log('✅ Cashfree response:', response.data);

        if (response.data && response.data.payment_session_id) {
            res.json({
                success: true,
                order_id: orderId,
                payment_session_id: response.data.payment_session_id,
                order_token: response.data.order_token || response.data.payment_session_id,
                amount: amount,
                environment: IS_PRODUCTION ? 'production' : 'sandbox'
            });
        } else {
            console.error('❌ No payment_session_id in response:', response.data);
            throw new Error('Failed to create order - no payment session ID received');
        }

    } catch (error) {
        console.error('❌ Order Creation Error:', {
            message: error.message,
            response: error.response?.data,
            status: error.response?.status
        });
        
        // Return specific error message
        let errorMessage = 'Failed to create order';
        
        if (error.response?.data?.message) {
            errorMessage = error.response.data.message;
        } else if (error.response?.status === 401 || error.response?.status === 403) {
            errorMessage = 'Authentication failed. Please verify your Cashfree credentials are correct for ' + 
                          (IS_PRODUCTION ? 'PRODUCTION' : 'SANDBOX') + ' mode';
        } else if (error.code === 'ENOTFOUND') {
            errorMessage = 'Cannot reach Cashfree servers. Check your internet connection.';
        }

        res.status(500).json({
            success: false,
            error: errorMessage,
            details: error.response?.data || error.message
        });
    }
});

// API: Verify Payment Status
app.post('/api/verify-payment', async (req, res) => {
    try {
        const { order_id } = req.body;

        if (!order_id) {
            return res.status(400).json({ success: false, error: 'Order ID required' });
        }

        console.log('🔍 Verifying payment for order:', order_id);

        // Fetch order status from Cashfree
        const response = await axios.get(
            `${CASHFREE_BASE_URL}/orders/${order_id}`,
            {
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'x-api-version': CASHFREE_API_VERSION,
                    'x-client-id': CASHFREE_APP_ID,
                    'x-client-secret': CASHFREE_SECRET_KEY
                }
            }
        );

        const orderStatus = response.data;
        console.log('📊 Order status:', orderStatus);

        if (orderStatus.order_status === 'PAID') {
            res.json({
                success: true,
                message: 'Payment verified successfully',
                order_id: order_id,
                payment_id: orderStatus.cf_order_id,
                order_status: orderStatus.order_status,
                order_amount: orderStatus.order_amount
            });
        } else {
            res.json({
                success: false,
                message: 'Payment not completed',
                order_status: orderStatus.order_status
            });
        }

    } catch (error) {
        console.error('❌ Verify Error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: error.response?.data?.message || error.message
        });
    }
});

// Webhook endpoint
app.post('/api/webhook', express.raw({type: 'application/json'}), (req, res) => {
    try {
        const signature = req.headers['x-webhook-signature'];
        const timestamp = req.headers['x-webhook-timestamp'];

        console.log('📨 Webhook received:', {
            timestamp,
            hasSignature: !!signature
        });

        // Parse body
        const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

        // Verify webhook signature
        const signatureData = timestamp + body;
        const computedSignature = crypto
            .createHmac('sha256', CASHFREE_SECRET_KEY)
            .update(signatureData)
            .digest('base64');

        if (signature === computedSignature) {
            console.log('✅ Webhook verified');
            const data = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
            console.log('Webhook data:', data);
            res.json({ success: true });
        } else {
            console.error('❌ Invalid webhook signature');
            res.status(400).json({ success: false, error: 'Invalid signature' });
        }

    } catch (error) {
        console.error('❌ Webhook Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Payment response handler
app.get('/payment-response', (req, res) => {
    const orderId = req.query.order_id;
    const status = req.query.order_status || 'success';
    console.log('💳 Payment response:', { orderId, status });
    res.redirect(`/?order_id=${orderId}&status=${status}`);
});

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Test endpoint
app.get('/api/test', (req, res) => {
    res.json({ 
        status: 'ok',
        mode: IS_PRODUCTION ? 'PRODUCTION' : 'SANDBOX',
        baseUrl: CASHFREE_BASE_URL,
        hasCredentials: !!(CASHFREE_APP_ID && CASHFREE_SECRET_KEY),
        appIdPreview: CASHFREE_APP_ID ? '***' + CASHFREE_APP_ID.slice(-4) : 'MISSING',
        timestamp: new Date().toISOString()
    });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('\n' + '='.repeat(60));
    console.log('🚀 UPI Voice Payment Server Started');
    console.log('='.repeat(60));
    console.log(`📍 Server URL: http://localhost:${PORT}`);
    console.log(`🔑 App ID: ${CASHFREE_APP_ID ? '✅ Loaded (***' + CASHFREE_APP_ID.slice(-4) + ')' : '❌ MISSING'}`);
    console.log(`🔐 Secret: ${CASHFREE_SECRET_KEY ? '✅ Loaded (***' + CASHFREE_SECRET_KEY.slice(-4) + ')' : '❌ MISSING'}`);
    console.log(`🌍 Mode: ${IS_PRODUCTION ? '🔴 PRODUCTION (LIVE)' : '🟡 SANDBOX (TEST)'}`);
    console.log(`🔗 API Base: ${CASHFREE_BASE_URL}`);
    console.log('='.repeat(60) + '\n');
});
