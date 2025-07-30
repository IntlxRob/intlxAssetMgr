const axios = require('axios');
require('dotenv').config();

const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL;
const ZENDESK_TOKEN = process.env.ZENDESK_TOKEN;
const ZENDESK_ASSET_OBJECT_KEY = process.env.ZENDESK_ASSET_OBJECT_KEY || 'asset';

const zendeskBaseURL = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;

const zendeskService = {
  async searchUsers(name) {
    console.debug('[DEBUG] searchUsers() called with name:', name);
    try {
      const res = await axios.get(`${zendeskBaseURL}/users/search.json?query=${encodeURIComponent(name)}`, {
        auth: { username: `${ZENDESK_EMAIL}/token`, password: ZENDESK_TOKEN }
      });
      console.debug(`[DEBUG] searchUsers() returned ${res.data.users.length} users`);
      return res.data.users;
    } catch (error) {
      console.error('[ERROR] searchUsers:', error.message);
      return [];
    }
  },

  async getOrganizations() {
    console.debug('[DEBUG] getOrganizations() called');
    try {
      const res = await axios.get(`${zendeskBaseURL}/organizations.json`, {
        auth: { username: `${ZENDESK_EMAIL}/token`, password: ZENDESK_TOKEN }
      });
      console.debug(`[DEBUG] getOrganizations() returned ${res.data.organizations.length} organizations`);
      return res.data.organizations;
    } catch (error) {
      console.error('[ERROR] getOrganizations:', error.message);
      return [];
    }
  },

  async getAllAssets() {
    console.debug('[DEBUG] getAllAssets() called');
    try {
      const url = `${zendeskBaseURL}/custom_objects/objects/${ZENDESK_ASSET_OBJECT_KEY}.json`;
      const res = await axios.get(url, {
        auth: { username: `${ZENDESK_EMAIL}/token`, password: ZENDESK_TOKEN }
      });
      console.debug(`[DEBUG] getAllAssets() returned ${res.data.data.length} assets`);
      return res.data.data;
    } catch (error) {
      console.error('[ERROR] getAllAssets:', error.message);
      return [];
    }
  },

  async getUserAssetsByName(name) {
    console.debug('[DEBUG] getUserAssetsByName() called with name:', name);
    try {
      const allAssets = await this.getAllAssets();
      const userAssets = allAssets.filter(a =>
        a.attributes?.assigned_user?.toLowerCase() === name.toLowerCase()
      );
      console.debug(`[DEBUG] getUserAssetsByName() matched ${userAssets.length} assets`);
      return userAssets;
    } catch (error) {
      console.error('[ERROR] getUserAssetsByName:', error.message);
      return [];
    }
  },

  async updateAsset(assetId, updatedFields) {
    console.debug('[DEBUG] updateAsset() called with ID:', assetId);
    try {
      const url = `${zendeskBaseURL}/custom_objects/objects/${ZENDESK_ASSET_OBJECT_KEY}/${assetId}.json`;
      const res = await axios.patch(url, { data: { attributes: updatedFields } }, {
        auth: { username: `${ZENDESK_EMAIL}/token`, password: ZENDESK_TOKEN }
      });
      console.debug('[DEBUG] updateAsset() success');
      return res.data;
    } catch (error) {
      console.error('[ERROR] updateAsset:', error.message);
      throw error;
    }
  },

  async createTicket(ticketData) {
    console.debug('[DEBUG] createTicket() called');
    try {
      const url = `${zendeskBaseURL}/tickets.json`;
      const res = await axios.post(url, { ticket: ticketData }, {
        auth: { username: `${ZENDESK_EMAIL}/token`, password: ZENDESK_TOKEN }
      });
      console.debug('[DEBUG] createTicket() success with ticket ID:', res.data.ticket?.id);
      return res.data.ticket;
    } catch (error) {
      console.error('[ERROR] createTicket:', error.message);
      throw error;
    }
  }
};

module.exports = zendeskService;
