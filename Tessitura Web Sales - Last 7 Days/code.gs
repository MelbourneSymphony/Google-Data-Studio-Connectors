// ============================================================
// AUTH FUNCTIONS
// ============================================================

function getAuthType() {
  const cc = DataStudioApp.createCommunityConnector();
  return cc.newAuthTypeResponse()
    .setAuthType(cc.AuthType.USER_PASS)
    .build();
}

function isAuthValid() {
  const credentials = getStoredCredentials();
  return !!(credentials.username && credentials.password);
}

function setCredentials(request) {
  const cc = DataStudioApp.createCommunityConnector();

  const username = request.userPass.username;
  const password = request.userPass.password;

  if (!username || !password) {
    return cc.newSetCredentialsResponse().setIsValid(false).build();
  }

  const props = PropertiesService.getScriptProperties();
  props.setProperty('dscc.username', username);
  props.setProperty('dscc.password', password);

  return cc.newSetCredentialsResponse().setIsValid(true).build();
}

function resetAuth() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty('dscc.username');
  props.deleteProperty('dscc.password');
}

function getStoredCredentials() {
  const props = PropertiesService.getScriptProperties();
  return {
    username: props.getProperty('dscc.username'),
    password: props.getProperty('dscc.password'),
  };
}

// ============================================================
// CONNECTOR CONFIG
// ============================================================

function getConfig(request) {
  const cc = DataStudioApp.createCommunityConnector();
  const config = cc.getConfig();
  config.setDateRangeRequired(false);
  return config.build();
}

// ============================================================
// SCHEMA
// ============================================================

function getFields() {
  const cc = DataStudioApp.createCommunityConnector();
  const fields = cc.getFields();
  const types = cc.FieldType;

  fields.newDimension()
    .setId('perf_no')
    .setName('Performance Number')
    .setType(types.NUMBER);

  fields.newDimension()
    .setId('perf_name')
    .setName('Performance Name')
    .setType(types.TEXT);

  fields.newDimension()
    .setId('perf_dt')
    .setName('Performance Date')
    .setType(types.YEAR_MONTH_DAY); // Tessitura dates standard format: YYYYMMDD

  fields.newMetric()
    .setId('Revenue')
    .setName('Ticket Revenue')
    .setType(types.CURRENCY_USD); // Adjust currency if needed (e.g., CURRENCY_AUD)

  fields.newMetric()
    .setId('Num_Tickets_Sold')
    .setName('Tickets Sold')
    .setType(types.NUMBER);

  return fields;
}

function getSchema(request) {
  return { schema: getFields().build() };
}

// ============================================================
// ADMIN
// ============================================================

function isAdminUser() {
  return true;
}

// ============================================================
// DATA FETCH
// ============================================================

function getData(request) {
  const cc = DataStudioApp.createCommunityConnector();

  // 1. Retrieve stored credentials
  const credentials = getStoredCredentials();
  if (!credentials.username || !credentials.password) {
    cc.newUserError()
      .setText('No credentials found. Please reconnect and enter your username and password.')
      .throwException();
  }

  // 2. Build Base64 Basic Auth header
  const base64Auth = Utilities.base64Encode(
    credentials.username + ':' + credentials.password
  );

  // 3. Call the Tessitura Custom/Execute endpoint
  const url = 'https://MELSO0AUVICwebprod.tnhs.cloud/Tessitura/api/Custom/Execute';

  const payload = {
    "ProcedureId": 81,
    "ProcedureName": "LSP_API_SALES_LAST_7",
    "ParameterValues": []
  };

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Basic ' + base64Auth },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const statusCode = response.getResponseCode();
  const responseText = response.getContentText();

  if (statusCode === 401) {
    cc.newUserError()
      .setDebugText('401 Unauthorized. Check your username and password.')
      .setText('Authentication failed. Please reconnect and re-enter your credentials.')
      .throwException();
  }

  if (statusCode !== 200) {
    cc.newUserError()
      .setDebugText('API returned status ' + statusCode + '. Body: ' + responseText)
      .setText('The Tessitura API returned an error. Please contact your administrator.')
      .throwException();
  }

  // 4. Parse the XML response
  // Response structure: <ExecuteLocalProcedureResults><Table>...</Table></ExecuteLocalProcedureResults>
  let tables;
  try {
    const document = XmlService.parse(responseText);
    const root = document.getRootElement(); // <ExecuteLocalProcedureResults>
    tables = root.getChildren('Table');
  } catch (e) {
    cc.newUserError()
      .setDebugText('Failed to parse XML response: ' + e.message + '. Raw: ' + responseText)
      .setText('Could not parse the data returned by the API.')
      .throwException();
  }

  // 5. Build the requested schema subset
  const fields = getFields();
  const requestedFields = fields.forIds(
    request.fields.map(function (field) {
      return field.name;
    })
  );

  // 6. Map XML rows to requested field order
  const rows = tables.map(function (table) {
    const values = requestedFields.asArray().map(function (field) {
      const child = table.getChild(field.getId());
      if (!child) return null;
      
      const val = child.getText();
      if (val === null || val === '') return null;

      // Smart parsing based on the Looker Studio schema definition type
      const type = field.getType();
      if (type === cc.FieldType.NUMBER || type === cc.FieldType.CURRENCY_USD) {
        return parseFloat(val);
      }
      
      return val; // Returns TEXT / DATES safely as string types
    });
    return { values: values };
  });

  return { 
    schema: requestedFields.build(), 
    rows: rows };
}