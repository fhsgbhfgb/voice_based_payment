// server.js - Cashfree Payment Backend
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Cashfree Configuration
const CASHFREE_APP_ID = process.env.CASHFREE_APP_ID;
const CASHFREE_SECRET_KEY = process.env.CASHFREE_SECRET_KEY;
const CASHFREE_API_VERSION = '2023-08-01';

// IMPORTANT: Check if credentials exist
if (!CASHFREE_APP_ID || !CASHFREE_SECRET_KEY) {
    console.error('❌ CASHFREE_APP_ID or CASHFREE_SECRET_KEY not found in .env file!');
    console.error('Please create a .env file with your Cashfree credentials');
    process.exit(1);
}

// Use production for live mode
const CASHFREE_BASE_URL = process.env.NODE_ENV === 'production'
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

        // Generate unique order ID
        const orderId = 'ORDER_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

        // Cashfree Order Request
        const orderData = {
            order_id: orderId,
            order_amount: parseFloat(amount),
            order_currency: 'INR',
            customer_details: {
                customer_id: 'CUST_' + Date.now(),
                customer_name: customerName || 'Customer',
                customer_email: customerEmail || 'customer@example.com',
                customer_phone: customerPhone || '9999999999'
            },
            order_meta: {
                return_url: `${req.protocol}://${req.get('host')}/payment-response?order_id=${orderId}`,
                notify_url: `${req.protocol}://${req.get('host')}/api/webhook`,
                payment_methods: 'upi'
            },
            order_note: `Payment to ${upiId}`
        };

        console.log('Creating order with Cashfree:', {
            url: `${CASHFREE_BASE_URL}/orders`,
            orderId: orderId,
            amount: amount,
            mode: process.env.NODE_ENV === 'production' ? 'PRODUCTION' : 'SANDBOX'
        });

        // Call Cashfree API
        const response = await axios.post(
            `${CASHFREE_BASE_URL}/orders`,
            orderData,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-version': CASHFREE_API_VERSION,
                    'x-client-id': CASHFREE_APP_ID,
                    'x-client-secret': CASHFREE_SECRET_KEY
                }
            }
        );

        console.log('✅ Order created successfully:', response.data);

        if (response.data && response.data.payment_session_id) {
            res.json({
                success: true,
                order_id: orderId,
                payment_session_id: response.data.payment_session_id,
                order_token: response.data.order_token,
                amount: amount,
                app_id: CASHFREE_APP_ID,
                environment: process.env.NODE_ENV === 'production' ? 'production' : 'sandbox'
            });
        } else {
            throw new Error('Failed to create order - no payment session ID');
        }

    } catch (error) {
        console.error('❌ Order Error:', error.response?.data || error.message);
        
        // Detailed error logging for debugging
        if (error.response) {
            console.error('Response status:', error.response.status);
            console.error('Response data:', JSON.stringify(error.response.data, null, 2));
        }

        // Return specific error message
        let errorMessage = 'Failed to create order';
        
        if (error.response?.data?.message) {
            errorMessage = error.response.data.message;
        } else if (error.response?.status === 401) {
            errorMessage = 'Authentication failed. Please check your Cashfree credentials (App ID and Secret Key)';
        } else if (error.response?.status === 403) {
            errorMessage = 'Access forbidden. Make sure you are using the correct production/sandbox credentials';
        }

        res.status(500).json({
            success: false,
            error: errorMessage
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

        console.log('Verifying payment for order:', order_id);

        // Fetch order status from Cashfree
        const response = await axios.get(
            `${CASHFREE_BASE_URL}/orders/${order_id}`,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-version': CASHFREE_API_VERSION,
                    'x-client-id': CASHFREE_APP_ID,
                    'x-client-secret': CASHFREE_SECRET_KEY
                }
            }
        );

        const orderStatus = response.data;
        console.log('Order status:', orderStatus);

        if (orderStatus.order_status === 'PAID') {
            // Payment successful
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

// Webhook endpoint (for production use)
app.post('/api/webhook', (req, res) => {
    try {
        const signature = req.headers['x-webhook-signature'];
        const timestamp = req.headers['x-webhook-timestamp'];

        console.log('Webhook received:', {
            timestamp,
            body: req.body
        });

        // Verify webhook signature
        const signatureData = timestamp + JSON.stringify(req.body);
        const computedSignature = crypto
            .createHmac('sha256', CASHFREE_SECRET_KEY)
            .update(signatureData)
            .digest('base64');

        if (signature === computedSignature) {
            console.log('✅ Webhook verified:', req.body);
            // Process webhook data (save to database, send notifications, etc.)
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
    console.log('Payment response received for order:', orderId);
    res.redirect(`/?order_id=${orderId}&status=success`);
});

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        mode: process.env.NODE_ENV === 'production' ? 'PRODUCTION' : 'SANDBOX',
        cashfree_configured: !!(CASHFREE_APP_ID && CASHFREE_SECRET_KEY)
    });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n✅ Server running at: http://localhost:${PORT}`);
    console.log(`🔑 Cashfree App ID: ${CASHFREE_APP_ID ? 'Loaded (***' + CASHFREE_APP_ID.slice(-4) + ')' : '❌ MISSING!'}`);
    console.log(`🔑 Cashfree Secret: ${CASHFREE_SECRET_KEY ? 'Loaded (***' + CASHFREE_SECRET_KEY.slice(-4) + ')' : '❌ MISSING!'}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV === 'production' ? '🔴 PRODUCTION (LIVE)' : '🟡 SANDBOX (TEST)'}`);
    console.log(`🔗 Base URL: ${CASHFREE_BASE_URL}`);
    console.log(`\n📱 Open http://localhost:${PORT} in Chrome\n`);
});
