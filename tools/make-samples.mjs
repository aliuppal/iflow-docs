/**
 * Generates sample exports in samples/ that mirror the structure SAP Cloud
 * Integration produces, so the parser, renderer and exporters can be exercised
 * end to end without a tenant.
 *
 *   node tools/make-samples.mjs
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { makeZip } from './zip-writer.mjs';

const OUT = fileURLToPath(new URL('../samples/', import.meta.url));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Content Modifier tables are an escaped XML blob of <row><cell><id>/<value>. */
function cellTable(rows) {
  const xml = rows
    .map(
      (row) =>
        '<row>' +
        Object.entries(row)
          .map(([id, value]) => `<cell><id>${esc(id)}</id><value>${esc(value)}</value></cell>`)
          .join('') +
        '</row>'
    )
    .join('');
  return esc(xml);
}

const props = (entries) =>
  '<bpmn2:extensionElements>' +
  Object.entries(entries)
    .map(([k, v]) => `<ifl:property><key>${esc(k)}</key><value>${v}</value></ifl:property>`)
    .join('') +
  '</bpmn2:extensionElements>';

const p = (entries) =>
  '<bpmn2:extensionElements>' +
  Object.entries(entries)
    .map(([k, v]) => `<ifl:property><key>${esc(k)}</key><value>${esc(v)}</value></ifl:property>`)
    .join('') +
  '</bpmn2:extensionElements>';

function shape(id, x, y, w, h) {
  return `<bpmndi:BPMNShape bpmnElement="${id}" id="BPMNShape_${id}"><dc:Bounds height="${h}" width="${w}" x="${x}" y="${y}"/></bpmndi:BPMNShape>`;
}
function edge(id, points) {
  return (
    `<bpmndi:BPMNEdge bpmnElement="${id}" id="BPMNEdge_${id}" sourceElement="" targetElement="">` +
    points.map(([x, y]) => `<di:waypoint x="${x}" xsi:type="dc:Point" y="${y}"/>`).join('') +
    '</bpmndi:BPMNEdge>'
  );
}

/* ------------------------------------------------------------------ */
/* Sample 1 — Employee replication                                     */
/* ------------------------------------------------------------------ */

const EMPLOYEE_IFLW = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn2:definitions xmlns:bpmn2="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
  xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
  xmlns:ifl="http:///com.sap.ifl.model/Ifl.xsd"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  id="Definitions_1">
  ${p({ description: 'Replicates active employees from SuccessFactors to S/4HANA on a schedule and archives each payload.' })}
  <bpmn2:collaboration id="Collaboration_1" name="Employee Replication">
    ${p({ namespaceMapping: '', allowedHeaderList: 'SAP_MessageType,SAP_Sender', httpSessionHandling: 'None', ServerTrace: 'false', returnExceptionToSender: 'false', log: 'All events' })}
    <bpmn2:participant id="Participant_Scheduler" ifl:type="EndpointSender" name="Scheduler">
      ${p({ enableBasicAuthentication: 'false', ifl_type: 'EndpointSender' })}
    </bpmn2:participant>
    <bpmn2:participant id="Participant_Process" ifl:type="IntegrationProcess" name="Integration Process" processRef="Process_1"/>
    <bpmn2:participant id="Participant_SFSF" ifl:type="EndpointRecevier" name="SuccessFactors EC">
      ${p({ ifl_type: 'EndpointRecevier' })}
    </bpmn2:participant>
    <bpmn2:participant id="Participant_S4" ifl:type="EndpointRecevier" name="S/4HANA">
      ${p({ ifl_type: 'EndpointRecevier' })}
    </bpmn2:participant>
    <bpmn2:participant id="Participant_Audit" ifl:type="EndpointRecevier" name="Audit Flow">
      ${p({ ifl_type: 'EndpointRecevier' })}
    </bpmn2:participant>

    <bpmn2:messageFlow id="MessageFlow_SFSF" name="OData V2" sourceRef="CallActivity_Fetch" targetRef="Participant_SFSF">
      ${p({
        ComponentType: 'OData',
        direction: 'Receiver',
        TransportProtocol: 'HTTP',
        MessageProtocol: 'OData V2',
        address: '{{SFSF_Address}}',
        resourcePath: 'PerPerson',
        operation: 'Query(GET)',
        queryOptions: '$filter=personIdExternal ne null&$select=personIdExternal,personal_information',
        authenticationMethod: 'Basic',
        credentialName: '{{SFSF_Credential}}',
        pageSize: '500',
        odataFields: 'personIdExternal,personal_information/first_name,personal_information/last_name',
      })}
    </bpmn2:messageFlow>
    <bpmn2:messageFlow id="MessageFlow_S4" name="Post employees" sourceRef="CallActivity_Post" targetRef="Participant_S4">
      ${p({
        ComponentType: 'HTTP',
        direction: 'Receiver',
        TransportProtocol: 'HTTP',
        MessageProtocol: 'None',
        httpAddressWithoutQuery: 'http://s4-legacy.internal.corp:8000/sap/bc/srt/employee',
        httpMethod: 'POST',
        httpRequestTimeout: '60000',
        authenticationMethod: 'Basic',
        credentialName: 'S4_BASIC_CRED',
        httpRequestHeaders: 'Content-Type,X-Correlation-Id',
      })}
    </bpmn2:messageFlow>
    <bpmn2:messageFlow id="MessageFlow_Audit" name="Audit hand-off" sourceRef="CallActivity_Audit" targetRef="Participant_Audit">
      ${p({ ComponentType: 'ProcessDirect', direction: 'Receiver', TransportProtocol: 'Not Applicable', MessageProtocol: 'Not Applicable', address: '/audit/employee-replication' })}
    </bpmn2:messageFlow>
    <bpmn2:messageFlow id="MessageFlow_Timer" name="Schedule" sourceRef="Participant_Scheduler" targetRef="StartEvent_1">
      ${p({ ComponentType: 'HTTPS', direction: 'Sender', TransportProtocol: 'HTTPS', MessageProtocol: 'None', urlPath: '/employee/replicate', senderAuthType: 'None', userRole: 'ESBMessaging.send' })}
    </bpmn2:messageFlow>
  </bpmn2:collaboration>

  <bpmn2:process id="Process_1" name="Integration Process">
    ${p({ transactionTimeout: '30', componentVersion: '1.2', cmdVariantUri: 'ctype::FlowElementVariant/cname::IntegrationProcess/version::1.2.0', transactionalHandling: 'Required for JDBC' })}

    <bpmn2:startEvent id="StartEvent_1" name="Start Timer">
      ${p({ activityType: 'Timer', scheduleKey: '{{Timer_Schedule}}', throwException: 'true' })}
      <bpmn2:outgoing>SequenceFlow_1</bpmn2:outgoing>
      <bpmn2:timerEventDefinition/>
    </bpmn2:startEvent>

    <bpmn2:callActivity id="CallActivity_Setup" name="Set Run Context">
      ${props({
        activityType: 'Enricher',
        bodyType: 'expression',
        wrapContent: '',
        bodyContent: esc('<Replication><RunId>${header.CamelCorrelationId}</RunId></Replication>'),
        propertyTable: cellTable([
          { Action: 'Create', Type: 'constant', Value: '{{Target_Company}}', Default: '', Name: 'CompanyCode', Datatype: '' },
          { Action: 'Create', Type: 'expression', Value: '${date:now:yyyy-MM-dd}', Default: '', Name: 'RunDate', Datatype: '' },
          { Action: 'Create', Type: 'xpath', Value: '/Replication/RunId', Default: 'unknown', Name: 'RunId', Datatype: 'java.lang.String' },
        ]),
        headerTable: cellTable([
          { Action: 'Create', Type: 'constant', Value: 'application/json', Default: '', Name: 'Content-Type', Datatype: '' },
        ]),
      })}
      <bpmn2:incoming>SequenceFlow_1</bpmn2:incoming>
      <bpmn2:outgoing>SequenceFlow_2</bpmn2:outgoing>
    </bpmn2:callActivity>

    <bpmn2:serviceTask id="CallActivity_Fetch" name="Read Employees">
      ${p({ activityType: 'ExternalCall', cmdVariantUri: 'ctype::FlowstepVariant/cname::ExternalCall/version::1.0' })}
      <bpmn2:incoming>SequenceFlow_2</bpmn2:incoming>
      <bpmn2:outgoing>SequenceFlow_3</bpmn2:outgoing>
    </bpmn2:serviceTask>

    <bpmn2:exclusiveGateway id="Gateway_1" name="Any employees?" default="SequenceFlow_Empty">
      ${p({ activityType: 'ExclusiveGateway', throwException: 'false' })}
      <bpmn2:incoming>SequenceFlow_3</bpmn2:incoming>
      <bpmn2:outgoing>SequenceFlow_Found</bpmn2:outgoing>
      <bpmn2:outgoing>SequenceFlow_Empty</bpmn2:outgoing>
    </bpmn2:exclusiveGateway>

    <bpmn2:callActivity id="CallActivity_Map" name="Map to S/4 Employee">
      ${p({
        activityType: 'Mapping',
        mappingType: 'MessageMapping',
        mappingname: 'SFSF_Employee_to_S4_Employee',
        mappingpath: 'src/main/resources/mapping/SFSF_Employee_to_S4_Employee.mmap',
        mappinguri: 'dt:SFSF_Employee_to_S4_Employee',
      })}
      <bpmn2:incoming>SequenceFlow_Found</bpmn2:incoming>
      <bpmn2:outgoing>SequenceFlow_4</bpmn2:outgoing>
    </bpmn2:callActivity>

    <bpmn2:callActivity id="CallActivity_Enrich" name="Add Correlation Id">
      ${p({ activityType: 'Script', scriptFunction: 'processData', script: 'AddCorrelationId.groovy', scriptBundleId: '' })}
      <bpmn2:incoming>SequenceFlow_4</bpmn2:incoming>
      <bpmn2:outgoing>SequenceFlow_5</bpmn2:outgoing>
    </bpmn2:callActivity>

    <bpmn2:callActivity id="CallActivity_Split" name="Split per Employee">
      ${p({ activityType: 'GeneralSplitter', xpath: '/Employees/Employee', groupingValue: '1', parallelProcessing: 'false', stopOnException: 'true', streaming: 'true' })}
      <bpmn2:incoming>SequenceFlow_5</bpmn2:incoming>
      <bpmn2:outgoing>SequenceFlow_6</bpmn2:outgoing>
    </bpmn2:callActivity>

    <bpmn2:serviceTask id="CallActivity_Post" name="Post to S/4HANA">
      ${p({ activityType: 'ExternalCall' })}
      <bpmn2:incoming>SequenceFlow_6</bpmn2:incoming>
      <bpmn2:outgoing>SequenceFlow_7</bpmn2:outgoing>
    </bpmn2:serviceTask>

    <bpmn2:callActivity id="CallActivity_Store" name="Archive Payload">
      ${p({ activityType: 'DBstorage', operation: 'Write', storeName: 'EMPLOYEE_ARCHIVE', visibility: 'Global', entryID: '\${property.RunId}', retentionThreshold: '90', overwriteExistingMessage: 'true', encrypt: 'true' })}
      <bpmn2:incoming>SequenceFlow_7</bpmn2:incoming>
      <bpmn2:outgoing>SequenceFlow_8</bpmn2:outgoing>
    </bpmn2:callActivity>

    <bpmn2:serviceTask id="CallActivity_Audit" name="Hand off to Audit">
      ${p({ activityType: 'Send' })}
      <bpmn2:incoming>SequenceFlow_8</bpmn2:incoming>
      <bpmn2:outgoing>SequenceFlow_9</bpmn2:outgoing>
    </bpmn2:serviceTask>

    <bpmn2:endEvent id="EndEvent_1" name="End">
      ${p({ activityType: 'MessageEndEvent' })}
      <bpmn2:incoming>SequenceFlow_9</bpmn2:incoming>
    </bpmn2:endEvent>

    <bpmn2:callActivity id="CallActivity_NoData" name="Log Empty Result">
      ${p({ activityType: 'Script', scriptFunction: 'logEmpty', script: 'LogEmptyResult.groovy' })}
      <bpmn2:incoming>SequenceFlow_Empty</bpmn2:incoming>
      <bpmn2:outgoing>SequenceFlow_10</bpmn2:outgoing>
    </bpmn2:callActivity>

    <bpmn2:endEvent id="EndEvent_Empty" name="Nothing to do">
      ${p({ activityType: 'MessageEndEvent' })}
      <bpmn2:incoming>SequenceFlow_10</bpmn2:incoming>
    </bpmn2:endEvent>

    <bpmn2:subProcess id="SubProcess_Error" name="Handle Replication Error" triggeredByEvent="true">
      ${p({ activityType: 'ErrorEventSubProcessTemplate' })}
      <bpmn2:startEvent id="StartEvent_Err" name="Error Start">
        ${p({ activityType: 'ErrorStartEvent' })}
        <bpmn2:outgoing>SequenceFlow_E1</bpmn2:outgoing>
      </bpmn2:startEvent>
      <bpmn2:callActivity id="CallActivity_ErrLog" name="Build Error Payload">
        ${props({
          activityType: 'Enricher',
          bodyType: 'constant',
          bodyContent: esc('<Error><Flow>Employee_Replication</Flow><Message>${exception.message}</Message></Error>'),
          propertyTable: cellTable([{ Action: 'Create', Type: 'expression', Value: '${exception.message}', Default: '', Name: 'ErrorText', Datatype: '' }]),
          headerTable: '',
        })}
        <bpmn2:incoming>SequenceFlow_E1</bpmn2:incoming>
        <bpmn2:outgoing>SequenceFlow_E2</bpmn2:outgoing>
      </bpmn2:callActivity>
      <bpmn2:callActivity id="CallActivity_ErrNotify" name="Raise Alert">
        ${p({ activityType: 'Script', scriptFunction: 'raiseAlert', script: 'RaiseAlert.groovy' })}
        <bpmn2:incoming>SequenceFlow_E2</bpmn2:incoming>
        <bpmn2:outgoing>SequenceFlow_E3</bpmn2:outgoing>
      </bpmn2:callActivity>
      <bpmn2:endEvent id="EndEvent_Err" name="Error End">
        ${p({ activityType: 'ErrorEndEvent', errorMessage: 'Employee replication failed' })}
        <bpmn2:incoming>SequenceFlow_E3</bpmn2:incoming>
        <bpmn2:errorEventDefinition/>
      </bpmn2:endEvent>
      <bpmn2:sequenceFlow id="SequenceFlow_E1" sourceRef="StartEvent_Err" targetRef="CallActivity_ErrLog"/>
      <bpmn2:sequenceFlow id="SequenceFlow_E2" sourceRef="CallActivity_ErrLog" targetRef="CallActivity_ErrNotify"/>
      <bpmn2:sequenceFlow id="SequenceFlow_E3" sourceRef="CallActivity_ErrNotify" targetRef="EndEvent_Err"/>
    </bpmn2:subProcess>

    <bpmn2:sequenceFlow id="SequenceFlow_1" sourceRef="StartEvent_1" targetRef="CallActivity_Setup"/>
    <bpmn2:sequenceFlow id="SequenceFlow_2" sourceRef="CallActivity_Setup" targetRef="CallActivity_Fetch"/>
    <bpmn2:sequenceFlow id="SequenceFlow_3" sourceRef="CallActivity_Fetch" targetRef="Gateway_1"/>
    <bpmn2:sequenceFlow id="SequenceFlow_Found" name="Employees found" sourceRef="Gateway_1" targetRef="CallActivity_Map">
      ${p({ expressionType: 'XML', condition: "count(/Employees/Employee) > 0" })}
    </bpmn2:sequenceFlow>
    <bpmn2:sequenceFlow id="SequenceFlow_Empty" name="No employees" sourceRef="Gateway_1" targetRef="CallActivity_NoData">
      ${p({ isDefault: 'true' })}
    </bpmn2:sequenceFlow>
    <bpmn2:sequenceFlow id="SequenceFlow_4" sourceRef="CallActivity_Map" targetRef="CallActivity_Enrich"/>
    <bpmn2:sequenceFlow id="SequenceFlow_5" sourceRef="CallActivity_Enrich" targetRef="CallActivity_Split"/>
    <bpmn2:sequenceFlow id="SequenceFlow_6" sourceRef="CallActivity_Split" targetRef="CallActivity_Post"/>
    <bpmn2:sequenceFlow id="SequenceFlow_7" sourceRef="CallActivity_Post" targetRef="CallActivity_Store"/>
    <bpmn2:sequenceFlow id="SequenceFlow_8" sourceRef="CallActivity_Store" targetRef="CallActivity_Audit"/>
    <bpmn2:sequenceFlow id="SequenceFlow_9" sourceRef="CallActivity_Audit" targetRef="EndEvent_1"/>
    <bpmn2:sequenceFlow id="SequenceFlow_10" sourceRef="CallActivity_NoData" targetRef="EndEvent_Empty"/>
  </bpmn2:process>

  <bpmndi:BPMNDiagram id="BPMNDiagram_1" name="Employee Replication">
    <bpmndi:BPMNPlane bpmnElement="Collaboration_1" id="BPMNPlane_1">
      ${shape('Participant_Scheduler', 40, 180, 100, 140)}
      ${shape('Participant_Process', 200, 60, 1080, 520)}
      ${shape('Participant_SFSF', 1340, 60, 100, 140)}
      ${shape('Participant_S4', 1340, 240, 100, 140)}
      ${shape('Participant_Audit', 1340, 420, 100, 140)}

      ${shape('StartEvent_1', 250, 234, 32, 32)}
      ${shape('CallActivity_Setup', 330, 220, 110, 60)}
      ${shape('CallActivity_Fetch', 490, 220, 110, 60)}
      ${shape('Gateway_1', 650, 232, 36, 36)}
      ${shape('CallActivity_Map', 740, 130, 110, 60)}
      ${shape('CallActivity_Enrich', 890, 130, 110, 60)}
      ${shape('CallActivity_Split', 1040, 130, 110, 60)}
      ${shape('CallActivity_Post', 740, 300, 110, 60)}
      ${shape('CallActivity_Store', 890, 300, 110, 60)}
      ${shape('CallActivity_Audit', 1040, 300, 110, 60)}
      ${shape('EndEvent_1', 1190, 314, 32, 32)}
      ${shape('CallActivity_NoData', 650, 400, 110, 60)}
      ${shape('EndEvent_Empty', 810, 414, 32, 32)}

      ${shape('SubProcess_Error', 250, 480, 620, 90)}
      ${shape('StartEvent_Err', 275, 510, 28, 28)}
      ${shape('CallActivity_ErrLog', 340, 498, 110, 52)}
      ${shape('CallActivity_ErrNotify', 490, 498, 110, 52)}
      ${shape('EndEvent_Err', 650, 510, 28, 28)}

      ${edge('SequenceFlow_1', [[282, 250], [330, 250]])}
      ${edge('SequenceFlow_2', [[440, 250], [490, 250]])}
      ${edge('SequenceFlow_3', [[600, 250], [650, 250]])}
      ${edge('SequenceFlow_Found', [[668, 232], [668, 160], [740, 160]])}
      ${edge('SequenceFlow_Empty', [[668, 268], [668, 430], [650, 430]])}
      ${edge('SequenceFlow_4', [[850, 160], [890, 160]])}
      ${edge('SequenceFlow_5', [[1000, 160], [1040, 160]])}
      ${edge('SequenceFlow_6', [[1095, 190], [1095, 250], [795, 250], [795, 300]])}
      ${edge('SequenceFlow_7', [[850, 330], [890, 330]])}
      ${edge('SequenceFlow_8', [[1000, 330], [1040, 330]])}
      ${edge('SequenceFlow_9', [[1150, 330], [1190, 330]])}
      ${edge('SequenceFlow_10', [[760, 430], [810, 430]])}
      ${edge('SequenceFlow_E1', [[303, 524], [340, 524]])}
      ${edge('SequenceFlow_E2', [[450, 524], [490, 524]])}
      ${edge('SequenceFlow_E3', [[600, 524], [650, 524]])}
      ${edge('MessageFlow_Timer', [[140, 250], [250, 250]])}
      ${edge('MessageFlow_SFSF', [[600, 235], [1340, 130]])}
      ${edge('MessageFlow_S4', [[850, 315], [1340, 310]])}
      ${edge('MessageFlow_Audit', [[1150, 345], [1340, 490]])}
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn2:definitions>
`;

const ADD_CORRELATION = `import com.sap.gateway.ip.core.customdev.util.Message
import java.util.UUID

/**
 * Stamps a correlation id on the message so the S/4HANA call and the audit
 * trail can be matched up, and records the run in the message log.
 */
Message processData(Message message) {
    def headers = message.getHeaders()
    def properties = message.getProperties()

    // The run id and company code were put on the exchange by "Set Run Context".
    def runId = properties.get('RunId')
    def company = properties.get('CompanyCode')

    def correlationId = headers.get('X-Correlation-Id') ?: UUID.randomUUID().toString()
    message.setHeader('X-Correlation-Id', correlationId)
    message.setProperty('CorrelationId', correlationId)

    def body = message.getBody(java.lang.String) ?: ''
    if (!body.trim()) {
        throw new IllegalStateException('Mapped employee payload is empty')
    }
    message.setProperty('PayloadSize', body.length())

    def messageLog = messageLogFactory.getMessageLog(message)
    if (messageLog != null) {
        messageLog.setStringProperty('CorrelationId', correlationId)
        messageLog.setStringProperty('RunId', runId as String)
        messageLog.setStringProperty('CompanyCode', company as String)
        messageLog.addAttachmentAsString('Mapped payload', body, 'text/xml')
    }
    return message
}
`;

const LOG_EMPTY = `import com.sap.gateway.ip.core.customdev.util.Message

Message logEmpty(Message message) {
    def messageLog = messageLogFactory.getMessageLog(message)
    messageLog?.setStringProperty('Result', 'No employees returned for the selection')
    message.setBody('')
    return message
}
`;

const HELPER = `import com.sap.gateway.ip.core.customdev.util.Message

/** Shared helper kept for the retry scenario. Not wired into the flow. */
Message formatError(Message message) {
    return message
}
`;

const MMAP = `<?xml version="1.0" encoding="UTF-8"?>
<ns0:MappingDefinition xmlns:ns0="http://sap.com/xi/BASIS" name="SFSF_Employee_to_S4_Employee">
  <sourceStructures>
    <structure name="PerPerson" xsdPath="src/main/resources/xsd/SFSF_PerPerson.xsd"/>
  </sourceStructures>
  <targetStructures>
    <structure name="S4Employee" xsdPath="src/main/resources/xsd/S4_Employee.xsd"/>
  </targetStructures>
  <mappingLinks>
    <link sourcePath="/PerPerson/personIdExternal" targetPath="/S4Employee/EmployeeId"/>
    <link sourcePath="/PerPerson/personal_information/first_name" targetPath="/S4Employee/FirstName"/>
    <link sourcePath="/PerPerson/personal_information/last_name" targetPath="/S4Employee/LastName"/>
    <link sourcePath="/PerPerson/employment_information/start_date" targetPath="/S4Employee/HireDate"/>
  </mappingLinks>
  <functions>
    <function name="concat"/>
    <function name="formatDate"/>
  </functions>
</ns0:MappingDefinition>
`;

const XSD_SOURCE = `<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="http://sfsf.example.com/employee" elementFormDefault="qualified">
  <xs:element name="PerPerson">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="personIdExternal" type="xs:string"/>
        <xs:element name="personal_information" type="PersonalInformation"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
  <xs:complexType name="PersonalInformation">
    <xs:sequence>
      <xs:element name="first_name" type="xs:string"/>
      <xs:element name="last_name" type="xs:string"/>
    </xs:sequence>
  </xs:complexType>
</xs:schema>
`;

const XSD_TARGET = `<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="http://s4.example.com/employee" elementFormDefault="qualified">
  <xs:element name="S4Employee">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="EmployeeId" type="xs:string"/>
        <xs:element name="FirstName" type="xs:string"/>
        <xs:element name="LastName" type="xs:string"/>
        <xs:element name="HireDate" type="xs:date"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>
`;

const XSLT = `<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
  <xsl:output method="xml" indent="yes"/>
  <xsl:template match="/Employees">
    <EmployeeBatch>
      <xsl:apply-templates select="Employee"/>
    </EmployeeBatch>
  </xsl:template>
  <xsl:template match="Employee">
    <Item><xsl:value-of select="EmployeeId"/></Item>
  </xsl:template>
</xsl:stylesheet>
`;

const EMPLOYEE_PARAMS = `#Externalized parameters
#Generated for the sample
SFSF_Address=https://api4.successfactors.com/odata/v2
SFSF_Credential=SFSF_API_USER
Target_Company=1710
Timer_Schedule=
Retry_Limit=3
Obsolete_Endpoint=https://old-system.example.com/legacy
`;

const EMPLOYEE_PARAMDEF = `<?xml version="1.0" encoding="UTF-8"?>
<parameters>
  <param_references/>
  <parameter>
    <name>SFSF_Address</name>
    <datatype>xsd:string</datatype>
    <default>https://api4.successfactors.com/odata/v2</default>
    <description>Base OData URL of the SuccessFactors tenant.</description>
  </parameter>
  <parameter>
    <name>SFSF_Credential</name>
    <datatype>xsd:string</datatype>
    <default>SFSF_API_USER</default>
    <description>Name of the user credential artefact holding the API user.</description>
  </parameter>
  <parameter>
    <name>Target_Company</name>
    <datatype>xsd:string</datatype>
    <default>1710</default>
    <description>Company code written into every replicated record.</description>
  </parameter>
  <parameter>
    <name>Timer_Schedule</name>
    <datatype>xsd:string</datatype>
    <default></default>
    <description>Cron-like schedule key for the timer start event.</description>
  </parameter>
  <parameter>
    <name>Retry_Limit</name>
    <datatype>xsd:integer</datatype>
    <default>3</default>
    <description>Maximum retries before the message is routed to the error handler.</description>
  </parameter>
  <parameter>
    <name>Obsolete_Endpoint</name>
    <datatype>xsd:string</datatype>
    <default>https://old-system.example.com/legacy</default>
    <description>Left over from the previous version.</description>
  </parameter>
</parameters>
`;

function manifest({ name, symbolicName, version, description }) {
  return `Manifest-Version: 1.0
Bundle-ManifestVersion: 2
Bundle-Name: ${name}
Bundle-SymbolicName: ${symbolicName}; singleton:=true
Bundle-Version: ${version}
Bundle-Description: ${description}
SAP-BundleType: IntegrationFlow
SAP-NodeType: IFLMAP
SAP-RuntimeProfile: iflmap
Import-Package: com.sap.esb.application.services.cxf.interceptor,com.sap.e
 sb.camel.security.cms,com.sap.esb.webservice.audit.log,com.sap.it.op.agen
 t.api.access,com.sap.it.op.agent.api.mpl,javax.xml.ws
Origin-Bundle-Name: ${name}
Origin-Bundle-SymbolicName: ${symbolicName}
`;
}

const employeeFiles = {
  'META-INF/MANIFEST.MF': manifest({
    name: 'Employee Replication SFSF to S4',
    symbolicName: 'Employee_Replication_SFSF_to_S4',
    version: '1.3.2',
    description: 'Scheduled replication of active employees from SuccessFactors Employee Central to S/4HANA.',
  }),
  'src/main/resources/scenarioflows/integrationflow/Employee_Replication_SFSF_to_S4.iflw': EMPLOYEE_IFLW,
  'src/main/resources/script/AddCorrelationId.groovy': ADD_CORRELATION,
  'src/main/resources/script/LogEmptyResult.groovy': LOG_EMPTY,
  'src/main/resources/script/ErrorHelper.groovy': HELPER,
  'src/main/resources/mapping/SFSF_Employee_to_S4_Employee.mmap': MMAP,
  'src/main/resources/mapping/EmployeeBatch.xsl': XSLT,
  'src/main/resources/xsd/SFSF_PerPerson.xsd': XSD_SOURCE,
  'src/main/resources/xsd/S4_Employee.xsd': XSD_TARGET,
  'src/main/resources/parameters.prop': EMPLOYEE_PARAMS,
  'src/main/resources/parameters.propdef': EMPLOYEE_PARAMDEF,
  'metainfo.prop': 'description=Scheduled employee replication\n',
};

/* ------------------------------------------------------------------ */
/* Sample 2 — small audit flow, for the package export                 */
/* ------------------------------------------------------------------ */

const AUDIT_IFLW = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn2:definitions xmlns:bpmn2="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
  xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
  xmlns:ifl="http:///com.sap.ifl.model/Ifl.xsd"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" id="Definitions_2">
  ${p({ description: 'Receives audit events over ProcessDirect and writes them to a JMS queue for long-term storage.' })}
  <bpmn2:collaboration id="Collaboration_2" name="Audit Sink">
    <bpmn2:participant id="Participant_In" ifl:type="EndpointSender" name="Any Flow"/>
    <bpmn2:participant id="Participant_Proc" ifl:type="IntegrationProcess" name="Integration Process" processRef="Process_2"/>
    <bpmn2:participant id="Participant_Queue" ifl:type="EndpointRecevier" name="Audit Store"/>
    <bpmn2:messageFlow id="MessageFlow_In" name="Audit events" sourceRef="Participant_In" targetRef="StartEvent_2">
      ${p({ ComponentType: 'ProcessDirect', direction: 'Sender', address: '/audit/employee-replication' })}
    </bpmn2:messageFlow>
    <bpmn2:messageFlow id="MessageFlow_Out" name="Persist" sourceRef="EndEvent_2" targetRef="Participant_Queue">
      ${p({ ComponentType: 'JMS', direction: 'Receiver', queueName: 'audit.employee.events', retryInterval: '5', expirationPeriod: '90', deadLetterQueue: 'true' })}
    </bpmn2:messageFlow>
  </bpmn2:collaboration>
  <bpmn2:process id="Process_2" name="Integration Process">
    ${p({ transactionalHandling: 'Not Required' })}
    <bpmn2:startEvent id="StartEvent_2" name="Start">
      ${p({ activityType: 'MessageStartEvent' })}
      <bpmn2:outgoing>SF_A1</bpmn2:outgoing>
    </bpmn2:startEvent>
    <bpmn2:callActivity id="CA_Stamp" name="Stamp Received Time">
      ${props({
        activityType: 'Enricher',
        bodyType: 'constant',
        bodyContent: '',
        headerTable: cellTable([{ Action: 'Create', Type: 'expression', Value: '${date:now:yyyy-MM-dd HH:mm:ss}', Default: '', Name: 'AuditReceivedAt', Datatype: '' }]),
        propertyTable: '',
      })}
      <bpmn2:incoming>SF_A1</bpmn2:incoming>
      <bpmn2:outgoing>SF_A2</bpmn2:outgoing>
    </bpmn2:callActivity>
    <bpmn2:callActivity id="CA_Validate" name="Validate Event">
      ${p({ activityType: 'XmlValidator', xsdURI: 'src/main/resources/xsd/AuditEvent.xsd', preventException: 'false', payloadType: 'XML' })}
      <bpmn2:incoming>SF_A2</bpmn2:incoming>
      <bpmn2:outgoing>SF_A3</bpmn2:outgoing>
    </bpmn2:callActivity>
    <bpmn2:endEvent id="EndEvent_2" name="End">
      ${p({ activityType: 'MessageEndEvent' })}
      <bpmn2:incoming>SF_A3</bpmn2:incoming>
    </bpmn2:endEvent>
    <bpmn2:sequenceFlow id="SF_A1" sourceRef="StartEvent_2" targetRef="CA_Stamp"/>
    <bpmn2:sequenceFlow id="SF_A2" sourceRef="CA_Stamp" targetRef="CA_Validate"/>
    <bpmn2:sequenceFlow id="SF_A3" sourceRef="CA_Validate" targetRef="EndEvent_2"/>
  </bpmn2:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_2">
    <bpmndi:BPMNPlane bpmnElement="Collaboration_2" id="BPMNPlane_2">
      ${shape('Participant_In', 40, 120, 100, 120)}
      ${shape('Participant_Proc', 200, 60, 620, 240)}
      ${shape('Participant_Queue', 880, 120, 100, 120)}
      ${shape('StartEvent_2', 250, 164, 32, 32)}
      ${shape('CA_Stamp', 340, 150, 110, 60)}
      ${shape('CA_Validate', 500, 150, 110, 60)}
      ${shape('EndEvent_2', 670, 164, 32, 32)}
      ${edge('SF_A1', [[282, 180], [340, 180]])}
      ${edge('SF_A2', [[450, 180], [500, 180]])}
      ${edge('SF_A3', [[610, 180], [670, 180]])}
      ${edge('MessageFlow_In', [[140, 180], [250, 180]])}
      ${edge('MessageFlow_Out', [[702, 180], [880, 180]])}
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn2:definitions>
`;

const AUDIT_XSD = `<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="http://audit.example.com">
  <xs:element name="AuditEvent">
    <xs:complexType><xs:sequence>
      <xs:element name="Flow" type="xs:string"/>
      <xs:element name="RunId" type="xs:string"/>
    </xs:sequence></xs:complexType>
  </xs:element>
</xs:schema>
`;

const auditFiles = {
  'META-INF/MANIFEST.MF': manifest({
    name: 'Audit Sink',
    symbolicName: 'Audit_Sink',
    version: '1.0.4',
    description: 'Central audit event sink reached over ProcessDirect.',
  }),
  'src/main/resources/scenarioflows/integrationflow/Audit_Sink.iflw': AUDIT_IFLW,
  'src/main/resources/xsd/AuditEvent.xsd': AUDIT_XSD,
  'src/main/resources/parameters.prop': '#Externalized parameters\n',
};

/* ------------------------------------------------------------------ */

const VALUE_MAPPING = `<?xml version="1.0" encoding="UTF-8"?>
<vmgroups>
  <valmap_group>
    <valmap_id><agency>SuccessFactors</agency><scheme>CountryCode</scheme><value>USA</value></valmap_id>
    <valmap_id><agency>S4HANA</agency><scheme>LAND1</scheme><value>US</value></valmap_id>
  </valmap_group>
  <valmap_group>
    <valmap_id><agency>SuccessFactors</agency><scheme>CountryCode</scheme><value>DEU</value></valmap_id>
    <valmap_id><agency>S4HANA</agency><scheme>LAND1</scheme><value>DE</value></valmap_id>
  </valmap_group>
</vmgroups>
`;

const valueMappingFiles = {
  'META-INF/MANIFEST.MF': manifest({
    name: 'Country Code Mapping',
    symbolicName: 'Country_Code_Mapping',
    version: '1.0.1',
    description: 'Country code translation between SuccessFactors and S/4HANA.',
  }),
  'value_mapping.xml': VALUE_MAPPING,
};

async function main() {
  await mkdir(OUT, { recursive: true });

  const employeeZip = makeZip(employeeFiles);
  await writeFile(join(OUT, 'Employee_Replication_SFSF_to_S4.zip'), employeeZip);

  const auditZip = makeZip(auditFiles);
  await writeFile(join(OUT, 'Audit_Sink.zip'), auditZip);

  const valueZip = makeZip(valueMappingFiles);

  const packageZip = makeZip({
    'contentmetadata.md': '# HR Integration Suite\n\nEmployee replication and its audit sink.\n',
    'Employee_Replication_SFSF_to_S4.zip': employeeZip,
    'Audit_Sink.zip': auditZip,
    'Country_Code_Mapping.zip': valueZip,
  });
  await writeFile(join(OUT, 'HR_Integration_Suite_package.zip'), packageZip);

  // The layout Cloud Integration itself writes for a package export: artefacts
  // are extension-less "<id>_content" entries beside a "<id>.json", plus
  // resources.cnt and contentmetadata.md. Nothing in it ends in ".zip".
  const cpiFiles = {
    'contentmetadata.md': JSON.stringify({ id: 'HR_Integration_Suite', displayName: 'HR Integration Suite', description: 'Employee replication and its audit sink.', version: '1.0.0' }),
    'resources.cnt': Buffer.from(JSON.stringify({ resources: [
      { id: 'a1b2c3', resourceType: 'IFlow', displayName: 'Employee Replication (display name)' },
      { id: 'd4e5f6', resourceType: 'IFlow', displayName: 'Audit Sink' },
      { id: 'g7h8i9', resourceType: 'ValueMapping', displayName: 'Country Code Mapping' },
    ] })).toString('base64'),
    'a1b2c3_content': employeeZip,
    'a1b2c3.json': JSON.stringify({ id: 'a1b2c3', displayName: 'Employee Replication (display name)', resourceType: 'IFlow' }),
    'd4e5f6_content': auditZip,
    'd4e5f6.json': JSON.stringify({ id: 'd4e5f6', displayName: 'Audit Sink', resourceType: 'IFlow' }),
    'g7h8i9_content': valueZip,
    'g7h8i9.json': JSON.stringify({ id: 'g7h8i9', displayName: 'Country Code Mapping', resourceType: 'ValueMapping' }),
  };
  const cpiPackage = makeZip(cpiFiles);
  await writeFile(join(OUT, 'HR_Integration_Suite_cpi_layout.zip'), cpiPackage);

  // The same package wrapped in a folder, and the package zipped inside another zip.
  await writeFile(join(OUT, 'HR_Integration_Suite_wrapped.zip'),
    makeZip(Object.fromEntries(Object.entries(cpiFiles).map(([k, v]) => [`HR Integration Suite/${k}`, v]))));
  await writeFile(join(OUT, 'HR_Integration_Suite_zip_in_zip.zip'), makeZip({ 'HR_Integration_Suite.zip': cpiPackage }));

  console.log('Wrote samples/:');
  console.log('  Employee_Replication_SFSF_to_S4.zip   single integration flow');
  console.log('  Audit_Sink.zip                        single integration flow');
  console.log('  HR_Integration_Suite_package.zip      package with 3 artefacts (nested .zip files)');
  console.log('  HR_Integration_Suite_cpi_layout.zip   same package in the layout Cloud Integration writes');
  console.log('  HR_Integration_Suite_wrapped.zip      ...inside an extra folder');
  console.log('  HR_Integration_Suite_zip_in_zip.zip   ...zipped again inside another zip');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
