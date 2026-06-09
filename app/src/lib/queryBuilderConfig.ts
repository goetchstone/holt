// /app/src/lib/queryBuilderConfig.ts
//
// Entity definitions for the query builder. Each entity maps to a Prisma
// model with available columns, joins, and filter fields.

export interface ColumnDef {
  field: string;
  label: string;
  type: "string" | "number" | "date" | "boolean" | "decimal";
}

export interface JoinDef {
  relation: string;
  label: string;
  columns: ColumnDef[];
}

export interface FilterOption {
  field: string;
  label: string;
  type: "string" | "number" | "date" | "select";
  options?: string[];
}

export interface EntityDef {
  key: string;
  label: string;
  prismaModel: string;
  columns: ColumnDef[];
  joins: JoinDef[];
  filters: FilterOption[];
  defaultOrderBy: string;
}

export const ENTITIES: EntityDef[] = [
  {
    key: "ConsignmentItem",
    label: "Consignment Items",
    prismaModel: "consignmentItem",
    columns: [
      { field: "id", label: "ID", type: "number" },
      { field: "barcode", label: "Barcode", type: "string" },
      { field: "customerNumber", label: "Customer #", type: "string" },
      { field: "quality", label: "Quality", type: "string" },
      { field: "size", label: "Size", type: "string" },
      { field: "cost", label: "Cost", type: "decimal" },
      { field: "anchorPrice", label: "Anchor Price", type: "decimal" },
      { field: "retailPrice", label: "Retail Price", type: "decimal" },
      { field: "status", label: "Status", type: "string" },
      { field: "saleDate", label: "Sale Date", type: "date" },
      { field: "saleTransactionId", label: "Transaction ID", type: "string" },
      { field: "paidDate", label: "Paid Date", type: "date" },
      { field: "returnedDate", label: "Returned Date", type: "date" },
      { field: "creditOwed", label: "Credit Owed", type: "boolean" },
    ],
    joins: [
      {
        relation: "vendor",
        label: "Vendor",
        columns: [{ field: "vendor.name", label: "Vendor Name", type: "string" }],
      },
      {
        relation: "product",
        label: "Product",
        columns: [
          { field: "product.productNumber", label: "Product Number", type: "string" },
          { field: "product.name", label: "Product Name", type: "string" },
          { field: "product.externalId", label: "the POS ID", type: "number" },
        ],
      },
      {
        relation: "salesOrder",
        label: "Sales Order",
        columns: [
          { field: "salesOrder.orderno", label: "Order #", type: "string" },
          { field: "salesOrder.orderDate", label: "Order Date", type: "date" },
          { field: "salesOrder.status", label: "Order Status", type: "string" },
        ],
      },
      {
        relation: "consignmentPaymentBatch",
        label: "Payment Batch",
        columns: [
          { field: "consignmentPaymentBatch.batchDate", label: "Batch Date", type: "date" },
          { field: "consignmentPaymentBatch.checkNumber", label: "Check #", type: "string" },
        ],
      },
    ],
    filters: [
      {
        field: "status",
        label: "Status",
        type: "select",
        options: ["ON_FLOOR", "ON_APPROVAL", "SOLD", "PAID", "RETURNED_VENDOR", "MISSING"],
      },
      { field: "barcode", label: "Barcode", type: "string" },
      { field: "customerNumber", label: "Customer #", type: "string" },
      { field: "creditOwed", label: "Credit Owed", type: "select", options: ["true", "false"] },
    ],
    defaultOrderBy: "id",
  },
  {
    key: "SalesOrder",
    label: "Sales Orders",
    prismaModel: "salesOrder",
    columns: [
      { field: "id", label: "ID", type: "number" },
      { field: "orderno", label: "Order #", type: "string" },
      { field: "orderDate", label: "Order Date", type: "date" },
      { field: "status", label: "Status", type: "string" },
      { field: "salesperson", label: "Salesperson", type: "string" },
      { field: "storeLocation", label: "Store", type: "string" },
      { field: "externalCustomerCode", label: "Cuscode", type: "string" },
    ],
    joins: [
      {
        relation: "customer",
        label: "Customer",
        columns: [
          { field: "customer.firstName", label: "First Name", type: "string" },
          { field: "customer.lastName", label: "Last Name", type: "string" },
        ],
      },
      {
        relation: "lineItems",
        label: "Line Items",
        columns: [
          { field: "lineItems.partNo", label: "Part #", type: "string" },
          { field: "lineItems.productName", label: "Product Name", type: "string" },
          { field: "lineItems.netPrice", label: "Net Price", type: "decimal" },
          { field: "lineItems.lineItemStatus", label: "Line Status", type: "string" },
        ],
      },
    ],
    filters: [
      {
        field: "status",
        label: "Status",
        type: "select",
        options: ["QUOTE", "ORDER", "FULFILLED", "RETURNED", "CANCELLED"],
      },
      { field: "orderno", label: "Order #", type: "string" },
      { field: "salesperson", label: "Salesperson", type: "string" },
      { field: "storeLocation", label: "Store", type: "string" },
      { field: "orderDate", label: "Order Date", type: "date" },
    ],
    defaultOrderBy: "orderDate",
  },
  {
    key: "OrderLineItem",
    label: "Order Line Items",
    prismaModel: "orderLineItem",
    columns: [
      { field: "id", label: "ID", type: "number" },
      { field: "partNo", label: "Part #", type: "string" },
      { field: "barcode", label: "Barcode", type: "string" },
      { field: "productName", label: "Product Name", type: "string" },
      { field: "orderedQuantity", label: "Qty", type: "decimal" },
      { field: "netPrice", label: "Net Price", type: "decimal" },
      { field: "cost", label: "Cost", type: "decimal" },
      { field: "porNumber", label: "POR #", type: "string" },
      { field: "lineItemStatus", label: "Status", type: "string" },
      { field: "productId", label: "Product ID", type: "number" },
    ],
    joins: [
      {
        relation: "salesOrder",
        label: "Sales Order",
        columns: [
          { field: "salesOrder.orderno", label: "Order #", type: "string" },
          { field: "salesOrder.orderDate", label: "Order Date", type: "date" },
          { field: "salesOrder.status", label: "Order Status", type: "string" },
        ],
      },
      {
        relation: "product",
        label: "Product",
        columns: [
          { field: "product.productNumber", label: "Product Number", type: "string" },
          { field: "product.vendorId", label: "Vendor ID", type: "number" },
        ],
      },
    ],
    filters: [
      { field: "partNo", label: "Part #", type: "string" },
      { field: "productId", label: "Product ID", type: "number" },
      { field: "porNumber", label: "POR #", type: "string" },
      {
        field: "lineItemStatus",
        label: "Status",
        type: "select",
        options: ["ACTIVE", "CANCELLED"],
      },
    ],
    defaultOrderBy: "id",
  },
  {
    key: "PurchaseOrder",
    label: "Purchase Orders",
    prismaModel: "purchaseOrder",
    columns: [
      { field: "id", label: "ID", type: "number" },
      { field: "poNumber", label: "PO #", type: "string" },
      { field: "orderDate", label: "Order Date", type: "date" },
      { field: "expectedDelivery", label: "ESD", type: "date" },
      { field: "status", label: "Status", type: "string" },
      { field: "vendorAckNumber", label: "Ack #", type: "string" },
    ],
    joins: [
      {
        relation: "vendor",
        label: "Vendor",
        columns: [{ field: "vendor.name", label: "Vendor Name", type: "string" }],
      },
      {
        relation: "lineItems",
        label: "Line Items",
        columns: [
          { field: "lineItems.partNo", label: "Part #", type: "string" },
          { field: "lineItems.orderedQuantity", label: "Qty", type: "decimal" },
          { field: "lineItems.unitCost", label: "Unit Cost", type: "decimal" },
          { field: "lineItems.externalPorNo", label: "POR #", type: "string" },
          { field: "lineItems.productId", label: "Product ID", type: "number" },
        ],
      },
    ],
    filters: [
      {
        field: "status",
        label: "Status",
        type: "select",
        options: [
          "DRAFT",
          "SUBMITTED",
          "CONFIRMED",
          "RECEIVED_PARTIAL",
          "RECEIVED_FULL",
          "SHORT_CLOSED",
          "CANCELLED",
        ],
      },
      { field: "poNumber", label: "PO #", type: "string" },
      { field: "vendorId", label: "Vendor ID", type: "number" },
      { field: "orderDate", label: "Order Date", type: "date" },
    ],
    defaultOrderBy: "orderDate",
  },
  {
    key: "PurchaseOrderItem",
    label: "PO Line Items",
    prismaModel: "purchaseOrderItem",
    columns: [
      { field: "id", label: "ID", type: "number" },
      { field: "partNo", label: "Part #", type: "string" },
      { field: "productName", label: "Product Name", type: "string" },
      { field: "orderedQuantity", label: "Qty", type: "decimal" },
      { field: "unitCost", label: "Unit Cost", type: "decimal" },
      { field: "externalPorNo", label: "POR #", type: "string" },
      { field: "productId", label: "Product ID", type: "number" },
    ],
    joins: [
      {
        relation: "purchaseOrder",
        label: "Purchase Order",
        columns: [
          { field: "purchaseOrder.poNumber", label: "PO #", type: "string" },
          { field: "purchaseOrder.status", label: "PO Status", type: "string" },
          { field: "purchaseOrder.vendorId", label: "Vendor ID", type: "number" },
        ],
      },
      {
        relation: "product",
        label: "Product",
        columns: [{ field: "product.productNumber", label: "Product Number", type: "string" }],
      },
      {
        relation: "receivingRecords",
        label: "Receiving Records",
        columns: [
          { field: "receivingRecords.receivedDate", label: "Received Date", type: "date" },
          { field: "receivingRecords.quantityReceived", label: "Qty Received", type: "decimal" },
        ],
      },
    ],
    filters: [
      { field: "partNo", label: "Part #", type: "string" },
      { field: "productId", label: "Product ID", type: "number" },
      { field: "externalPorNo", label: "POR #", type: "string" },
      { field: "purchaseOrderId", label: "PO ID", type: "number" },
    ],
    defaultOrderBy: "id",
  },
  {
    key: "Product",
    label: "Products",
    prismaModel: "product",
    columns: [
      { field: "id", label: "ID", type: "number" },
      { field: "externalId", label: "the POS ID", type: "number" },
      { field: "productNumber", label: "Product Number", type: "string" },
      { field: "name", label: "Name", type: "string" },
      { field: "baseCost", label: "Base Cost", type: "decimal" },
      { field: "baseRetail", label: "Base Retail", type: "decimal" },
      { field: "isActive", label: "Active", type: "boolean" },
    ],
    joins: [
      {
        relation: "vendor",
        label: "Vendor",
        columns: [{ field: "vendor.name", label: "Vendor Name", type: "string" }],
      },
      {
        relation: "department",
        label: "Department",
        columns: [{ field: "department.name", label: "Department", type: "string" }],
      },
      {
        relation: "upcs",
        label: "UPCs / Barcodes",
        columns: [{ field: "upcs.upc", label: "UPC", type: "string" }],
      },
    ],
    filters: [
      { field: "productNumber", label: "Product Number", type: "string" },
      { field: "vendorId", label: "Vendor ID", type: "number" },
      { field: "name", label: "Name", type: "string" },
      { field: "departmentId", label: "Department ID", type: "number" },
    ],
    defaultOrderBy: "id",
  },
  {
    key: "Customer",
    label: "Customers",
    prismaModel: "customer",
    columns: [
      { field: "id", label: "ID", type: "number" },
      { field: "firstName", label: "First Name", type: "string" },
      { field: "lastName", label: "Last Name", type: "string" },
      { field: "email", label: "Email", type: "string" },
      { field: "phone", label: "Phone", type: "string" },
      { field: "tradeCompanyName", label: "Trade Company", type: "string" },
    ],
    joins: [],
    filters: [
      { field: "firstName", label: "First Name", type: "string" },
      { field: "lastName", label: "Last Name", type: "string" },
      { field: "email", label: "Email", type: "string" },
    ],
    defaultOrderBy: "id",
  },
  {
    key: "ReceivingRecord",
    label: "Receiving Records",
    prismaModel: "receivingRecord",
    columns: [
      { field: "id", label: "ID", type: "number" },
      { field: "quantityReceived", label: "Qty Received", type: "decimal" },
      { field: "receivedDate", label: "Received Date", type: "date" },
      { field: "externalGipNo", label: "GIP #", type: "string" },
      { field: "externalPorNo", label: "POR #", type: "string" },
      { field: "lineCost", label: "Line Cost", type: "decimal" },
      { field: "condition", label: "Condition", type: "string" },
    ],
    joins: [
      {
        relation: "purchaseOrder",
        label: "Purchase Order",
        columns: [
          { field: "purchaseOrder.poNumber", label: "PO #", type: "string" },
          { field: "purchaseOrder.vendorId", label: "Vendor ID", type: "number" },
        ],
      },
      {
        relation: "purchaseOrderItem",
        label: "PO Item",
        columns: [
          { field: "purchaseOrderItem.partNo", label: "Part #", type: "string" },
          { field: "purchaseOrderItem.productId", label: "Product ID", type: "number" },
        ],
      },
    ],
    filters: [
      { field: "externalPorNo", label: "POR #", type: "string" },
      { field: "receivedDate", label: "Received Date", type: "date" },
      { field: "purchaseOrderId", label: "PO ID", type: "number" },
    ],
    defaultOrderBy: "receivedDate",
  },
];

export function getEntityDef(key: string): EntityDef | undefined {
  return ENTITIES.find((e) => e.key === key);
}
