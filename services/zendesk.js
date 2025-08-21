/**
 * Gets all asset records associated with a given user ID.
 * Filters locally on custom_object_fields.assigned_to.
 */
async function getUserAssets(userId) {
    try {
        const requestUrl = `/custom_objects/${ZENDESK_ASSET_OBJECT_KEY}/records.json`;
        console.log(`Fetching ALL assets from Zendesk: ${zendeskApi.defaults.baseURL}${requestUrl}`);
        const response = await zendeskApi.get(requestUrl);

        const allRecords = response.data.custom_object_records || [];
        console.log(`Fetched ${allRecords.length} total records.`);

        // Filter locally by assigned_to custom field
        const userAssets = allRecords.filter(
            (record) => String(record.custom_object_fields?.assigned_to) === String(userId)
        );

        console.log(`Found ${userAssets.length} assets for user ID ${userId}`);
        return userAssets;
    } catch (error) {
        console.error(`Error in getUserAssets for user ID ${userId}:`, error.response?.data || error.message);
        return [];
    }
}
