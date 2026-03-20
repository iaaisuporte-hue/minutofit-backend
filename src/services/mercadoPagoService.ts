import axios from 'axios';

const MERCADO_PAGO_API_BASE = 'https://api.mercadopago.com';
const ACCESS_TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN || '';

interface MercadoPagoSubscriptionData {
  reason: string;
  auto_recurring: {
    frequency: number;
    frequency_type: string;
    transaction_amount: number;
    currency_id: string;
    start_date: string;
  };
  notification_url: string;
  payer_email: string;
  back_url: string;
  external_reference: string;
  items?: Array<{
    title: string;
    description?: string;
    quantity: number;
    unit_price: number;
    currency_id: string;
  }>;
}

interface MercadoPagoPreapprovalResponse {
  id: string;
  status: string;
  init_point: string;
  sandbox_init_point: string;
  payer: {
    email: string;
  };
  auto_recurring: {
    frequency: number;
    frequency_type: string;
    transaction_amount: number;
    currency_id: string;
  };
}

export async function createPreapprovalSubscription(
  userId: number,
  subscriptionTierName: string,
  amountBrl: number,
  userEmail: string
): Promise<{ preapprovalId: string; initPoint: string }> {
  try {
    const subscriptionData: MercadoPagoSubscriptionData = {
      reason: `MinutoFit ${subscriptionTierName} Subscription`,
      auto_recurring: {
        frequency: 1,
        frequency_type: 'months',
        transaction_amount: amountBrl,
        currency_id: 'BRL',
        start_date: new Date().toISOString()
      },
      payer_email: userEmail,
      notification_url: `${process.env.FRONTEND_URL}/api/webhooks/mercadopago`,
      back_url: `${process.env.FRONTEND_URL}/subscriptions/success`,
      external_reference: `user_${userId}_${Date.now()}`
    };

    const response = await axios.post<MercadoPagoPreapprovalResponse>(
      `${MERCADO_PAGO_API_BASE}/preapproval`,
      subscriptionData,
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return {
      preapprovalId: response.data.id,
      initPoint: process.env.NODE_ENV === 'production' 
        ? response.data.init_point 
        : response.data.sandbox_init_point
    };
  } catch (error: any) {
    console.error('Mercado Pago error:', error.response?.data || error.message);
    throw new Error('Failed to create subscription');
  }
}

export async function getPreapprovalStatus(preapprovalId: string): Promise<any> {
  try {
    const response = await axios.get(
      `${MERCADO_PAGO_API_BASE}/preapproval/${preapprovalId}`,
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`
        }
      }
    );

    return response.data;
  } catch (error: any) {
    console.error('Mercado Pago error:', error.response?.data || error.message);
    throw new Error('Failed to get subscription status');
  }
}

export async function cancelPreapproval(preapprovalId: string): Promise<void> {
  try {
    await axios.put(
      `${MERCADO_PAGO_API_BASE}/preapproval/${preapprovalId}`,
      { status: 'cancelled' },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`
        }
      }
    );
  } catch (error: any) {
    console.error('Mercado Pago error:', error.response?.data || error.message);
    throw new Error('Failed to cancel subscription');
  }
}

export async function getPaymentInfo(paymentId: string): Promise<any> {
  try {
    const response = await axios.get(
      `${MERCADO_PAGO_API_BASE}/v1/payments/${paymentId}`,
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`
        }
      }
    );

    return response.data;
  } catch (error: any) {
    console.error('Mercado Pago error:', error.response?.data || error.message);
    throw new Error('Failed to get payment info');
  }
}
