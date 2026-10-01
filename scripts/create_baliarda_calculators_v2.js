const fs = require('fs');
const path = require('path');

const CALC_REPO = process.env.CALC_REPO || '/tmp/calcmcp';
const EstimateBuilder = require(path.join(CALC_REPO, 'lib/aws/estimate-builder'));

const REGION = 'us-east-1';
const GROUPS = {
  compute: '01 - COMPUTO, IA Y APLICACION',
  data: '02 - DATOS Y BASES DE DATOS',
  security: '03 - SEGURIDAD Y GOBIERNO',
  network: '04 - NETWORKING E INTEGRACION',
  support: '05 - SOPORTE, MONITOREO Y NOTIFICACIONES',
};

function readCatalog(name) {
  return JSON.parse(
    fs.readFileSync(path.join(CALC_REPO, 'catalog/services', `${name}.json`), 'utf8'),
  );
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function merge(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      merge(target[key], value);
    } else {
      target[key] = clone(value);
    }
  }
  return target;
}

function catalogConfig(catalogName, subService, overrides = {}) {
  const catalog = readCatalog(catalogName);
  const base = subService ? catalog.minimalConfig[subService] : catalog.minimalConfig;
  if (!base) {
    throw new Error(`No minimalConfig for ${catalogName}/${subService || ''}`);
  }
  return merge(clone(base), overrides);
}

function templateHint(catalogName, subService) {
  const catalog = readCatalog(catalogName);
  if (!subService) return catalog.templateId;
  return (catalog.subServices || []).find((item) => item.serviceCode === subService)?.estimateFor;
}

function add(builder, service, instance, group, config, templateIdHint) {
  builder.addService(`${service}:${instance}`, config, { group, templateIdHint });
}

function addLambda(builder, instance, description, requestsMillion, durationMs, memoryGb = 1) {
  add(
    builder,
    'aWSLambda',
    instance,
    GROUPS.compute,
    catalogConfig('aWSLambda', null, {
      region: REGION,
      description,
      numberOfRequests: { value: String(requestsMillion), unit: 'millionPerMonth' },
      durationOfEachRequest: String(durationMs),
      sizeOfMemoryAllocated: { value: String(memoryGb), unit: 'gb|NA' },
      selectArchitectureRequests: '2',
      selectArchitectureConcurrency: '2',
    }),
    templateHint('aWSLambda'),
  );
}

function addAppSync(builder, instance, description, callsMillion) {
  add(
    builder,
    'appSyncApiCall',
    instance,
    GROUPS.compute,
    catalogConfig('awsAppSync', 'appSyncApiCall', {
      region: REGION,
      description,
      requestVolume: { value: String(callsMillion), unit: 'millionPerMonth' },
    }),
    templateHint('awsAppSync', 'appSyncApiCall'),
  );
}

function addStepFunctions(builder, instance, description, executions, transitions) {
  add(
    builder,
    'stepFunctionStandard',
    instance,
    GROUPS.compute,
    catalogConfig('awsStepFunctions', 'stepFunctionStandard', {
      region: REGION,
      description,
      numberOfExecutions: { value: String(executions), unit: 'perMonth' },
      stateTransition: String(transitions),
    }),
    templateHint('awsStepFunctions', 'stepFunctionStandard'),
  );
}

function addBedrock(builder, instance, description, inputTokensMonthly, outputTokensMonthly) {
  const requestsPerMonth = 1800; // 1 request/min x 1 hour/day x 30 days
  add(
    builder,
    'anthropic',
    instance,
    GROUPS.compute,
    catalogConfig('amazonBedrock', 'anthropic', {
      region: REGION,
      description,
      avgRequestsPerMin: '1',
      hoursPerDayAtThisRate: '1',
      avgInputTokensPerRequest: String(
        Math.max(1, Math.round(inputTokensMonthly / requestsPerMonth)),
      ),
      avgOutputTokensPerRequest: String(
        Math.max(1, Math.round(outputTokensMonthly / requestsPerMonth)),
      ),
    }),
    templateHint('amazonBedrock', 'anthropic'),
  );
}

function addS3(builder, instance, description, storageGb) {
  add(
    builder,
    'amazonS3Standard',
    instance,
    GROUPS.data,
    catalogConfig('amazonSimpleStorageServiceGroup', 'amazonS3Standard', {
      region: REGION,
      description,
      s3StandardStorageSize: { value: String(storageGb), unit: 'gb|month' },
    }),
    templateHint('amazonSimpleStorageServiceGroup', 'amazonS3Standard'),
  );
}

function addRds(builder, instance, description, instanceType, storageGb) {
  add(
    builder,
    'amazonRDSPostgreSQLDB',
    instance,
    GROUPS.data,
    catalogConfig('amazonRDSPostgreSQLDB', null, {
      region: REGION,
      description,
      columnFormIPM: {
        value: [
          {
            'Number of Nodes': { value: '1' },
            'Instance Type': { value: instanceType },
            'Deployment Option': { value: 'Single-AZ' },
            TermType: { value: 'OnDemand' },
            undefined: {
              value: { unit: '100', selectedId: '%Utilized/Month' },
            },
          },
        ],
      },
      storageVolume: 'General Purpose-GP3',
      storageAmount: { value: String(storageGb), unit: 'gb|NA' },
    }),
    templateHint('amazonRDSPostgreSQLDB'),
  );
}

function addCommonSecurity(builder, mau, tokenRequests, s3OpsMillions = 1) {
  add(
    builder,
    'amazonCognito',
    'identidad-y-acceso',
    GROUPS.security,
    catalogConfig('amazonCognito', null, {
      region: REGION,
      description: `Cognito Essentials para autenticacion del MVP - ${mau} usuarios activos mensuales`,
      cognito_NumberOfMAUs_Essential: String(mau),
      cognitoEssentials_userTokenRequests: String(tokenRequests),
    }),
    templateHint('amazonCognito'),
  );

  add(
    builder,
    'awsCloudTrail',
    'auditoria',
    GROUPS.security,
    catalogConfig('awsCloudTrail', null, {
      region: REGION,
      description: 'Trazabilidad de accesos, eventos de datos y evidencia para auditoria',
      numberOfS3Ops: { value: String(s3OpsMillions), unit: 'perMonth' },
      numberOfS3Trails: '1',
    }),
    templateHint('awsCloudTrail'),
  );
}

function addCommonNetwork(builder, natGb, outboundGb, intraGb, integrationDescription) {
  add(
    builder,
    'networkAddressTranslationNatGatewayVpc',
    'salida-controlada',
    GROUPS.network,
    catalogConfig('networkAddressTranslationNatGatewayVpc', null, {
      region: REGION,
      description: `NAT Gateway regional para ${integrationDescription} - ${natGb} GB/mes procesados`,
      regionalNatGatewayCount: '1',
      regionalNatGatewayAzCount: '1',
      regionalNatGatewayDataProcessed: { value: String(natGb), unit: 'gb|month' },
      numberOfGateways: '0',
      dataProcessedPerNATGateway: { value: '0', unit: 'gb|month' },
    }),
    templateHint('networkAddressTranslationNatGatewayVpc'),
  );

  add(
    builder,
    'aWSDataTransfer',
    'transferencia',
    GROUPS.network,
    catalogConfig('aWSDataTransfer', null, {
      region: REGION,
      description: `Transferencia estimada: ${outboundGb} GB/mes a Internet y ${intraGb} GB/mes intra-region`,
      dataTransfer: {
        value: [
          { entryType: 'INBOUND', value: '0', unit: 'gb_month', fromRegion: 'External' },
          { entryType: 'OUTBOUND', value: String(outboundGb), unit: 'gb_month', toRegion: 'External' },
          { entryType: 'INTRA_REGION', value: String(intraGb), unit: 'gb_month' },
        ],
      },
    }),
    templateHint('aWSDataTransfer'),
  );
}

function addCommonSupport(builder, notificationsMillion, description) {
  add(
    builder,
    'standardTopics',
    'alertas-y-notificaciones',
    GROUPS.support,
    catalogConfig('amazonSimpleNotificationService', 'standardTopics', {
      region: REGION,
      description,
      numberOfRequests: { value: String(notificationsMillion), unit: 'millionPerMonth' },
    }),
    templateHint('amazonSimpleNotificationService', 'standardTopics'),
  );
}

function buildCU01() {
  const builder = new EstimateBuilder(
    'Baliarda - CU01 - Agente de Conocimiento y Mantenimiento Predictivo - MVP',
  );

  addLambda(
    builder,
    'backend-agente',
    'Backend serverless del agente, carga de incidencias, consulta tecnica y registro de intervenciones',
    0.25,
    1200,
    1,
  );
  addAppSync(
    builder,
    'api-mini-app',
    'API administrada para mini app, canal web y operaciones del agente de mantenimiento',
    0.2,
  );
  addStepFunctions(
    builder,
    'orquestacion-agente',
    'Orquestacion de ingesta, diagnostico asistido, validacion humana y aprendizaje por arreglos',
    5000,
    12,
  );
  addBedrock(
    builder,
    'rag-y-diagnostico',
    'Claude Sonnet 4 en Amazon Bedrock para RAG, diagnostico asistido y explicacion de recomendaciones',
    2000000,
    500000,
  );

  add(
    builder,
    'sageMakerStudioNotebooks',
    'desarrollo-ml',
    GROUPS.compute,
    catalogConfig('amazonSageMaker', 'sageMakerStudioNotebooks', {
      region: REGION,
      description: 'SageMaker Studio para preparacion, entrenamiento y validacion del modelo predictivo inicial',
      DataScientistsPerMonth: '1',
      NotebooksPerMonth: '1',
      NotebookHrsPerDay: '4',
      NotebookDaysPerMonth: '8',
      columnFormIPM: { value: [{ 'Instance Name': { value: 'ml.t3.medium' } }] },
    }),
    templateHint('amazonSageMaker', 'sageMakerStudioNotebooks'),
  );

  add(
    builder,
    'sageMakerRealTimeInference',
    'inferencia-ml',
    GROUPS.compute,
    catalogConfig('amazonSageMaker', 'sageMakerRealTimeInference', {
      region: REGION,
      description: 'Endpoint predictivo inicial activado en ventanas operativas y de validacion del MVP',
      modelsDeployed: '1',
      modelsPerEndPoint: '1',
      instancesPerEndPoint: '1',
      endpointHrsPerDay: '2',
      EndPointDaysPerMonth: '22',
      columnFormIPM: { value: [{ 'Instance Name': { value: 'ml.m5.large' } }] },
    }),
    templateHint('amazonSageMaker', 'sageMakerRealTimeInference'),
  );

  addS3(
    builder,
    'documentacion-y-datasets',
    'Manuales, procedimientos, historicos OEE, audit trails y datasets de entrenamiento',
    100,
  );
  addRds(
    builder,
    'kdb-y-operacion',
    'PostgreSQL/pgvector para conocimiento indexado, activos, incidencias, intervenciones y validaciones',
    'db.t4g.medium',
    100,
  );
  addCommonSecurity(builder, 40, 20000, 1);
  addCommonNetwork(
    builder,
    30,
    30,
    60,
    'integraciones con SAP/OEE/Enaxis, WhatsApp y correo',
  );
  addCommonSupport(
    builder,
    0.03,
    'Alertas operativas, notificaciones de fallas, avisos de repuestos y eventos de seguimiento',
  );

  return builder;
}

function buildCU04() {
  const builder = new EstimateBuilder(
    'Baliarda - CU04 - Auditoria de Facturas Logisticas - MVP',
  );

  addLambda(
    builder,
    'procesamiento-documental',
    'Ingesta, extraccion, normalizacion y reglas de conciliacion para 50-60 comprobantes por mes',
    0.12,
    3000,
    1,
  );
  addAppSync(
    builder,
    'api-bandeja-auditoria',
    'API administrada para bandeja de comprobantes, detalle, historial y aprobacion humana',
    0.1,
  );
  addStepFunctions(
    builder,
    'orquestacion-auditoria',
    'Workflow de recepcion, clasificacion, cruces, excepciones, revision y salida para SAP',
    2000,
    20,
  );
  addBedrock(
    builder,
    'clasificacion-y-explicacion',
    'Claude Sonnet 4 en Amazon Bedrock para lectura heterogenea, clasificacion y explicacion de desvios',
    500000,
    100000,
  );

  addS3(
    builder,
    'comprobantes-y-evidencia',
    'Originales, anexos, tarifarios, extractos SAP, archivos de supervisores y evidencia de auditoria',
    50,
  );
  addRds(
    builder,
    'auditoria-y-trazabilidad',
    'Persistencia de comprobantes, conceptos, reglas, decisiones, historico y trazabilidad',
    'db.t4g.small',
    50,
  );
  addCommonSecurity(builder, 25, 12000, 1);
  addCommonNetwork(
    builder,
    20,
    20,
    40,
    'correo/repositorio, extractos SAP y archivos entregados por Baliarda',
  );
  addCommonSupport(
    builder,
    0.01,
    'Alertas por comprobantes objetados, no certificables y pendientes de revision',
  );

  return builder;
}

function buildCU05() {
  const builder = new EstimateBuilder(
    'Baliarda - CU05 - Stocks de Seguridad Dinamicos - MVP',
  );

  addLambda(
    builder,
    'motor-analitico',
    'Preparacion mensual, reglas estadisticas y generacion de recomendaciones para 20-30 APIs y muestra critica',
    0.06,
    5000,
    1,
  );
  addAppSync(
    builder,
    'api-planificacion',
    'API administrada para consulta de SKU, recomendaciones, alertas y aprobacion humana',
    0.05,
  );
  addStepFunctions(
    builder,
    'orquestacion-stock',
    'Workflow mensual de ingesta, calculo, explicacion, aprobacion y exportacion para actualizacion manual en SAP',
    500,
    25,
  );
  addBedrock(
    builder,
    'explicacion-de-recomendaciones',
    'Claude Sonnet 4 en Amazon Bedrock para explicar recomendaciones y contextualizar excepciones de abastecimiento',
    300000,
    100000,
  );

  addS3(
    builder,
    'datos-de-planificacion',
    'Exportaciones SAP, movimientos, forecast, ordenes abiertas, campañas y condiciones de proveedores',
    20,
  );
  addRds(
    builder,
    'recomendaciones-y-decisiones',
    'Persistencia de parametros, recomendaciones, explicaciones, decisiones y trazabilidad del planificador',
    'db.t4g.small',
    50,
  );
  addCommonSecurity(builder, 20, 10000, 1);
  addCommonNetwork(
    builder,
    15,
    15,
    30,
    'exportaciones SAP, repositorio de campañas y consultas externas controladas',
  );
  addCommonSupport(
    builder,
    0.01,
    'Alertas de aproximacion al stock minimo, recomendaciones pendientes y eventos del proceso mensual',
  );

  return builder;
}

async function exportEstimate(builder, outputDir, code) {
  const payload = await builder.toAWSPayload();
  const exported = await builder.export();
  fs.writeFileSync(
    path.join(outputDir, `${code}_payload.json`),
    JSON.stringify(payload, null, 2),
  );
  return {
    title: builder.name,
    estimate_id: exported.estimateId,
    url: exported.shareableUrl,
    groups: Object.values(GROUPS),
  };
}

(async () => {
  const outputDir = process.env.OUTPUT_DIR || '/tmp/calculator-output';
  fs.mkdirSync(outputDir, { recursive: true });

  const definitions = [
    ['CU01', buildCU01()],
    ['CU04', buildCU04()],
    ['CU05', buildCU05()],
  ];

  const result = {
    generated_at: new Date().toISOString(),
    region: REGION,
    currency: 'USD',
    calculators: {},
    shared_assumptions: [
      'Independent MVP estimates in us-east-1.',
      'On-demand pricing, without private discounts or Savings Plans.',
      'AWS Business Support is account-level and is not duplicated in the three estimates.',
      'CU04 and CU05 reuse a common foundation; a consolidated TCO must deduplicate shared fixed components.',
      'SAP partner work, WhatsApp/BSP fees and third-party portal integration are excluded.',
    ],
  };

  for (const [code, builder] of definitions) {
    console.log(`Creating ${code}...`);
    result.calculators[code] = await exportEstimate(builder, outputDir, code);
    console.log(`${code}: ${result.calculators[code].url}`);
  }

  fs.writeFileSync(
    path.join(outputDir, 'urls.json'),
    JSON.stringify(result, null, 2),
  );

  fs.writeFileSync(
    path.join(outputDir, 'README.md'),
    [
      '# AWS Pricing Calculator - Laboratorios Baliarda',
      '',
      `Region: ${REGION}`,
      'Currency: USD',
      '',
      ...Object.entries(result.calculators).map(
        ([code, item]) => `- **${code}** - ${item.title}: ${item.url}`,
      ),
      '',
      '## Shared assumptions',
      ...result.shared_assumptions.map((item) => `- ${item}`),
      '',
    ].join('\n'),
  );

  console.log(JSON.stringify(result, null, 2));
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
