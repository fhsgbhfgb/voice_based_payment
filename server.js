// server.js - Cashfree Payment Backend
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Enable CORS
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

// Check credentials
if (!CASHFREE_APP_ID || !CASHFREE_SECRET_KEY) {
    console.error('❌ CASHFREE_APP_ID or CASHFREE_SECRET_KEY not found!');
}

// Determine environment
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const CASHFREE_BASE_URL = IS_PRODUCTION
    ? 'https://api.cashfree.com/pg'
    : 'https://sandbox.cashfree.com/pg';

// Get the correct base URL for callbacks
function getBaseUrl(req) {
    // Check if we're on Vercel
    const host = req.get('host');
    
    if (host.includes('vercel.app') || host.includes('localhost')) {
        return host.includes('localhost') 
            ? `http://${host}` 
            : `https://${host}`;
    }
    
    // Fallback
    return `${req.protocol}://${host}`;
}

// API: Create Cashfree Order
app.post('/api/create-order', async (req, res) => {
    try {
        const { amount, upiId, customerName, customerPhone, customerEmail } = req.body;

        // Validate
        if (!amount || amount <= 0) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid amount' 
            });
        }

        if (!CASHFREE_APP_ID || !CASHFREE_SECRET_KEY) {
            return res.status(500).json({ 
                success: false, 
                error: 'Cashfree credentials not configured. Please set CASHFREE_APP_ID and CASHFREE_SECRET_KEY in environment variables.' 
            });
        }

        // Generate unique IDs
        const timestamp = Date.now();
        const randomStr = Math.random().toString(36).substr(2, 9);
        const orderId = `ORDER_${timestamp}_${randomStr}`;
        const customerId = `CUST_${timestamp}`;

        // Get base URL
        const baseUrl = getBaseUrl(req);
        const returnUrl = `${baseUrl}/payment-response?order_id=${orderId}`;
        const notifyUrl = `${baseUrl}/api/webhook`;

        console.log('📝 Creating order:', {
            orderId,
            amount: parseFloat(amount).toFixed(2),
            mode: IS_PRODUCTION ? '🔴 PRODUCTION' : '🟡 SANDBOX',
            returnUrl,
            notifyUrl
        });

        // Cashfree Order Request
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
                return_url: returnUrl,
                notify_url: notifyUrl
            },
            order_note: `Payment to ${upiId || 'UPI'}`
        };

        console.log('📤 Sending to Cashfree:', CASHFREE_BASE_URL + '/orders');

        // Call Cashfree API
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
                },
                timeout: 10000 // 10 second timeout
            }
        );

        console.log('✅ Cashfree response:', response.data);

        if (!response.data || !response.data.payment_session_id) {
            console.error('❌ Missing payment_session_id in response');
            throw new Error('Invalid response from Cashfree - no payment session ID');
        }

        // Success response
        res.json({
            success: true,
            order_id: orderId,
            payment_session_id: response.data.payment_session_id,
            order_token: response.data.order_token || response.data.payment_session_id,
            amount: amount,
            environment: IS_PRODUCTION ? 'production' : 'sandbox',
            return_url: returnUrl
        });

    } catch (error) {
        console.error('❌ Order Creation Error:', {
            message: error.message,
            response: error.response?.data,
            status: error.response?.status,
            code: error.code
        });

        // Determine specific error message
        let errorMessage = 'Failed to create payment order';
        let errorDetails = {};

        if (error.response) {
            const status = error.response.status;
            const data = error.response.data;

            if (status === 401 || status === 403) {
                errorMessage = 'Authentication failed. Please check your Cashfree credentials.';
                errorDetails = {
                    hint: 'Make sure you are using PRODUCTION credentials for production mode',
                    mode: IS_PRODUCTION ? 'PRODUCTION' : 'SANDBOX'
                };
            } else if (status === 400) {
                errorMessage = data?.message || 'Invalid request to Cashfree';
                
                // Check for domain whitelisting error
                if (data?.message?.includes('whitelist') || data?.message?.includes('domain')) {
                    errorMessage = 'Domain not whitelisted. Please add your domain to Cashfree whitelist.';
                    errorDetails = {
                        hint: 'Login to Cashfree Dashboard → Developers → Whitelist your domain',
                        domain: getBaseUrl({ get: () => process.env.VERCEL_URL || 'localhost:3000' })
                    };
                }
            } else if (status === 429) {
                errorMessage = 'Too many requests. Please try again in a moment.';
            } else {
                errorMessage = data?.message || 'Cashfree API error';
            }
        } else if (error.code === 'ECONNABORTED') {
            errorMessage = 'Request timeout. Please check your internet connection.';
        } else if (error.code === 'ENOTFOUND') {
            errorMessage = 'Cannot reach Cashfree servers. Please check your internet connection.';
        } else if (error.request) {
            errorMessage = 'No response from Cashfree. Please try again.';
        }

        res.status(500).json({
            success: false,
            error: errorMessage,
            details: errorDetails,
            debug: {
                status: error.response?.status,
                code: error.code,
                cashfreeError: error.response?.data
            }
        });
    }
});

// API: Verify Payment Status
app.post('/api/verify-payment', async (req, res) => {
    try {
        const { order_id } = req.body;

        if (!order_id) {
            return res.status(400).json({ 
                success: false, 
                error: 'Order ID required' 
            });
        }

        console.log('🔍 Verifying payment:', order_id);

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
        console.log('📊 Order status:', orderStatus.order_status);

        res.json({
            success: orderStatus.order_status === 'PAID',
            message: orderStatus.order_status === 'PAID' 
                ? 'Payment verified successfully' 
                : 'Payment not completed',
            order_id: order_id,
            order_status: orderStatus.order_status,
            order_amount: orderStatus.order_amount,
            payment_time: orderStatus.payment_time
        });

    } catch (error) {
        console.error('❌ Verify Error:', error.response?.data || error.message);
        
        res.status(500).json({
            success: false,
            error: error.response?.data?.message || 'Failed to verify payment',
            order_id: req.body.order_id
        });
    }
});

// Webhook endpoint
app.post('/api/webhook', express.raw({type: 'application/json'}), (req, res) => {
    try {
        const signature = req.headers['x-webhook-signature'];
        const timestamp = req.headers['x-webhook-timestamp'];

        console.log('📨 Webhook received');

        if (!signature || !timestamp) {
            console.error('❌ Missing webhook headers');
            return res.status(400).json({ success: false, error: 'Missing headers' });
        }

        // Parse body
        const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

        // Verify signature
        const signatureData = timestamp + body;
        const computedSignature = crypto
            .createHmac('sha256', CASHFREE_SECRET_KEY)
            .update(signatureData)
            .digest('base64');

        if (signature === computedSignature) {
            const data = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
            console.log('✅ Webhook verified:', data);
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
    const status = req.query.order_status || 'processing';
    
    console.log('💳 Payment response:', { orderId, status });
    
    res.redirect(`/?order_id=${orderId}&status=${status}`);
});

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok',
        timestamp: new Date().toISOString(),
        mode: IS_PRODUCTION ? 'PRODUCTION' : 'SANDBOX',
        baseUrl: CASHFREE_BASE_URL,
        hasCredentials: !!(CASHFREE_APP_ID && CASHFREE_SECRET_KEY)
    });
});

// Test endpoint
app.get('/api/test', (req, res) => {
    const baseUrl = getBaseUrl(req);
    
    res.json({ 
        status: 'ok',
        mode: IS_PRODUCTION ? 'PRODUCTION' : 'SANDBOX',
        baseUrl: CASHFREE_BASE_URL,
        hasCredentials: !!(CASHFREE_APP_ID && CASHFREE_SECRET_KEY),
        appIdPreview: CASHFREE_APP_ID ? '***' + CASHFREE_APP_ID.slice(-4) : 'MISSING',
        serverUrl: baseUrl,
        timestamp: new Date().toISOString()
    });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('\n' + '='.repeat(70));
    console.log('🚀 UPI Voice Payment Server');
    console.log('='.repeat(70));
    console.log(`📍 Server: http://localhost:${PORT}`);
    console.log(`🔑 App ID: ${CASHFREE_APP_ID ? '✅ ***' + CASHFREE_APP_ID.slice(-4) : '❌ MISSING'}`);
    console.log(`🔐 Secret: ${CASHFREE_SECRET_KEY ? '✅ ***' + CASHFREE_SECRET_KEY.slice(-4) : '❌ MISSING'}`);
    console.log(`🌍 Mode: ${IS_PRODUCTION ? '🔴 PRODUCTION' : '🟡 SANDBOX'}`);
    console.log(`🔗 API: ${CASHFREE_BASE_URL}`);
    console.log('='.repeat(70) + '\n');
    
    if (!CASHFREE_APP_ID || !CASHFREE_SECRET_KEY) {
        console.error('⚠️  WARNING: Cashfree credentials missing!');
        console.error('⚠️  Set CASHFREE_APP_ID and CASHFREE_SECRET_KEY in .env\n');
    }
});
