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

// Use sandbox for testing, production for live
const CASHFREE_BASE_URL = process.env.NODE_ENV === 'production'
    ? 'https://api.cashfree.com/pg'
    : 'https://sandbox.cashfree.com/pg';

// Generate signature for Cashfree API authentication
function generateSignature(postData) {
    const signatureData = postData;
    const signature = crypto
        .createHmac('sha256', CASHFREE_SECRET_KEY)
        .update(signatureData)
        .digest('base64');
    return signature;
}

// API: Create Cashfree Order
app.post('/api/create-order', async (req, res) => {
    try {
        const { amount, upiId, customerName, customerPhone, customerEmail } = req.body;

        // Validate
        if (!amount || amount <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid amount' });
        }

        // Generate unique order ID
        const orderId = 'ORDER_' + Date.now();

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
            throw new Error('Failed to create order');
        }

    } catch (error) {
        console.error('Order Error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: error.response?.data?.message || error.message
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
        console.error('Verify Error:', error.response?.data || error.message);
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

        // Verify webhook signature
        const signatureData = timestamp + JSON.stringify(req.body);
        const computedSignature = crypto
            .createHmac('sha256', CASHFREE_SECRET_KEY)
            .update(signatureData)
            .digest('base64');

        if (signature === computedSignature) {
            console.log('Webhook verified:', req.body);
            // Process webhook data (save to database, send notifications, etc.)
            res.json({ success: true });
        } else {
            res.status(400).json({ success: false, error: 'Invalid signature' });
        }

    } catch (error) {
        console.error('Webhook Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Payment response handler
app.get('/payment-response', (req, res) => {
    const orderId = req.query.order_id;
    res.redirect(`/?order_id=${orderId}&status=success`);
});

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n✅ Server running at: http://localhost:${PORT}`);
    console.log(`🔑 Cashfree App ID: ${CASHFREE_APP_ID ? 'Loaded' : 'MISSING!'}`);
    console.log(`🔑 Environment: ${process.env.NODE_ENV === 'production' ? 'PRODUCTION' : 'SANDBOX'}`);
    console.log(`\n📱 Open http://localhost:${PORT} in Chrome\n`);
});