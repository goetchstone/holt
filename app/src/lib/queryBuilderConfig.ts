// /app/src/lib/queryBuilderConfig.ts
//
// Entity definitions for the query builder (ad-hoc reporting, GAP-34). Each entity
// maps to a Prisma model with the columns, joins, filters and totals it offers. This
// list is the security model: the server selects, filters and totals only what's
// named here (lib/queryBuilderQuery.ts), and __tests__/queryBuilderConfig.test.ts
// checks every name against the schema.
//
// Pure: the screen imports it too.

import { COUNTED_LINE_STATUSES, SALES_REVENUE_STATUSES } from "@/lib/salesOrderRevenue";

export interface ColumnDef {
  field: string;
  label: string;
  type: "string" | "number" | "date" | "boolean" | "decimal";
  /** What the store pays: left out for a caller without View cost. */
  cost?: true;
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
  /** The column can hold NULL, so "not equal" has to name it (rule 51). */
  nullable?: true;
}

export interface GroupDef {
  key: string;
  label: string;
  /** A column, through to-one relations only: a to-many has no single value to group by. */
  path: string;
  bucket?: "month";
}

export interface MeasureDef {
  key: string;
  label: string;
  type: "number" | "decimal";
  field: string;
  /** Multiplied by this before adding up, for a line with no stored total. */
  times?: string;
  cost?: true;
}

/** What can be totalled, and over which rows (rules 31, 33, 47). */
export interface TotalsDef {
  /** Which rows count. Every entity states this, so no total answers a question nobody asked. */
  where: Record<string, unknown>;
  /** The same thing in words, shown beside the totals. */
  says: string;
  countLabel: string;
  groups: GroupDef[];
  measures: MeasureDef[];
}

export interface EntityDef {
  key: string;
  label: string;
  prismaModel: string;
  columns: ColumnDef[];
  joins: JoinDef[];
  filters: FilterOption[];
  defaultOrderBy: string;
  totals: TotalsDef;
}

/** Which operators each filter type takes. Shared, so the screen offers what the server accepts. */
export const FILTER_OPS = {
  string: ["equals", "contains", "startsWith", "not"],
  number: ["equals", "gt", "gte", "lt", "lte", "not"],
  date: ["equals", "gt", "gte", "lt", "lte"],
  select: ["equals", "not"],
} as const;

export const COUNT_MEASURE = "count";

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
      { field: "cost", label: "Cost", type: "decimal", cost: true },
      { field: "anchorPrice", label: "Anchor Price", type: "decimal", cost: true },
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
      { field: "customerNumber", label: "Customer #", type: "string", nullable: true },
      { field: "creditOwed", label: "Credit Owed", type: "select", options: ["true", "false"] },
      { field: "saleDate", label: "Sale Date", type: "date", nullable: true },
    ],
    defaultOrderBy: "id",
    totals: {
      where: {},
      says: "Every item, whatever its status. Group by status to separate what's sold from what's on the floor.",
      countLabel: "Items",
      groups: [
        { key: "status", label: "Status", path: "status" },
        { key: "vendor", label: "Vendor", path: "vendor.name" },
        { key: "saleMonth", label: "Sale month", path: "saleDate", bucket: "month" },
        { key: "creditOwed", label: "Credit owed", path: "creditOwed" },
      ],
      measures: [
        { key: "retailPrice", label: "Retail Price", type: "decimal", field: "retailPrice" },
        { key: "cost", label: "Cost", type: "decimal", field: "cost", cost: true },
      ],
    },
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
      { field: "salesperson", label: "Salesperson", type: "string", nullable: true },
      { field: "storeLocation", label: "Store", type: "string", nullable: true },
      { field: "orderDate", label: "Order Date", type: "date", nullable: true },
    ],
    defaultOrderBy: "orderDate",
    totals: {
      where: { status: { not: "CANCELLED" } },
      says: "Leaves out cancelled orders. Quotes and returns count under their own status, so group by status to separate them. For money, use Order Line Items.",
      countLabel: "Orders",
      groups: [
        { key: "status", label: "Status", path: "status" },
        { key: "salesperson", label: "Salesperson", path: "salesperson" },
        { key: "store", label: "Store", path: "storeLocation" },
        { key: "orderMonth", label: "Order month", path: "orderDate", bucket: "month" },
      ],
      measures: [],
    },
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
      { field: "cost", label: "Cost", type: "decimal", cost: true },
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
      { field: "partNo", label: "Part #", type: "string", nullable: true },
      { field: "productId", label: "Product ID", type: "number", nullable: true },
      { field: "porNumber", label: "POR #", type: "string", nullable: true },
      {
        field: "lineItemStatus",
        label: "Status",
        type: "select",
        options: ["ACTIVE", "CANCELLED", "BACKORDERED", "REPLACED"],
      },
      { field: "salesOrder.orderDate", label: "Order Date", type: "date", nullable: true },
      { field: "salesOrder.salesperson", label: "Salesperson", type: "string", nullable: true },
      { field: "salesOrder.storeLocation", label: "Store", type: "string", nullable: true },
    ],
    defaultOrderBy: "id",
    totals: {
      where: {
        lineItemStatus: { in: [...COUNTED_LINE_STATUSES] },
        orderedQuantity: { not: 0 },
        salesOrder: { status: { in: [...SALES_REVENUE_STATUSES] } },
      },
      says: "Lines on orders. Leaves out quotes, cancelled orders, cancelled and replaced lines, and zero quantities. Returned orders stay in, so returns net out, and a delivery fee counts as a line.",
      countLabel: "Lines",
      groups: [
        { key: "salesperson", label: "Salesperson", path: "salesOrder.salesperson" },
        { key: "store", label: "Store", path: "salesOrder.storeLocation" },
        { key: "orderMonth", label: "Order month", path: "salesOrder.orderDate", bucket: "month" },
        { key: "orderStatus", label: "Order status", path: "salesOrder.status" },
        { key: "vendor", label: "Vendor", path: "product.vendor.name" },
        { key: "department", label: "Department", path: "product.department.name" },
        { key: "category", label: "Category", path: "product.category.name" },
        { key: "product", label: "Product", path: "productName" },
      ],
      measures: [
        { key: "netPrice", label: "Net Price", type: "decimal", field: "netPrice" },
        { key: "tax", label: "Tax", type: "decimal", field: "vatAmount" },
        { key: "quantity", label: "Qty", type: "number", field: "orderedQuantity" },
        { key: "cost", label: "Cost", type: "decimal", field: "cost", cost: true },
      ],
    },
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
          { field: "lineItems.unitCost", label: "Unit Cost", type: "decimal", cost: true },
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
    totals: {
      where: { status: { not: "CANCELLED" } },
      says: "Leaves out cancelled POs. For quantities and cost, use PO Line Items.",
      countLabel: "POs",
      groups: [
        { key: "status", label: "Status", path: "status" },
        { key: "vendor", label: "Vendor", path: "vendor.name" },
        { key: "orderMonth", label: "Order month", path: "orderDate", bucket: "month" },
      ],
      measures: [],
    },
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
      { field: "unitCost", label: "Unit Cost", type: "decimal", cost: true },
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
      { field: "partNo", label: "Part #", type: "string", nullable: true },
      { field: "productId", label: "Product ID", type: "number", nullable: true },
      { field: "externalPorNo", label: "POR #", type: "string", nullable: true },
      { field: "purchaseOrderId", label: "PO ID", type: "number" },
      { field: "purchaseOrder.orderDate", label: "Order Date", type: "date" },
    ],
    defaultOrderBy: "id",
    totals: {
      where: { orderedQuantity: { not: 0 }, purchaseOrder: { status: { not: "CANCELLED" } } },
      says: "Lines on POs. Leaves out cancelled POs and zero quantities.",
      countLabel: "Lines",
      groups: [
        { key: "vendor", label: "Vendor", path: "purchaseOrder.vendor.name" },
        { key: "status", label: "PO status", path: "purchaseOrder.status" },
        {
          key: "orderMonth",
          label: "Order month",
          path: "purchaseOrder.orderDate",
          bucket: "month",
        },
        { key: "product", label: "Product", path: "productName" },
      ],
      measures: [
        { key: "quantity", label: "Qty", type: "number", field: "orderedQuantity" },
        {
          key: "cost",
          label: "Cost",
          type: "decimal",
          field: "orderedQuantity",
          times: "unitCost",
          cost: true,
        },
      ],
    },
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
      { field: "baseCost", label: "Base Cost", type: "decimal", cost: true },
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
    totals: {
      where: {},
      says: "Every product, active or not. Group by Active to separate them.",
      countLabel: "Products",
      groups: [
        { key: "vendor", label: "Vendor", path: "vendor.name" },
        { key: "department", label: "Department", path: "department.name" },
        { key: "category", label: "Category", path: "category.name" },
        { key: "active", label: "Active", path: "isActive" },
      ],
      measures: [],
    },
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
      { field: "firstName", label: "First Name", type: "string", nullable: true },
      { field: "lastName", label: "Last Name", type: "string", nullable: true },
      { field: "email", label: "Email", type: "string", nullable: true },
      { field: "created", label: "Added", type: "date" },
    ],
    defaultOrderBy: "id",
    totals: {
      where: {},
      says: "Every customer record.",
      countLabel: "Customers",
      groups: [
        { key: "addedMonth", label: "Month added", path: "created", bucket: "month" },
        { key: "group", label: "Customer group", path: "customerGroup" },
      ],
      measures: [],
    },
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
      { field: "lineCost", label: "Line Cost", type: "decimal", cost: true },
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
      { field: "externalPorNo", label: "POR #", type: "string", nullable: true },
      { field: "receivedDate", label: "Received Date", type: "date" },
      { field: "purchaseOrderId", label: "PO ID", type: "number" },
    ],
    defaultOrderBy: "receivedDate",
    totals: {
      where: {},
      says: "Every receipt recorded.",
      countLabel: "Receipts",
      groups: [
        { key: "vendor", label: "Vendor", path: "purchaseOrder.vendor.name" },
        { key: "receivedMonth", label: "Month received", path: "receivedDate", bucket: "month" },
        { key: "condition", label: "Condition", path: "condition" },
      ],
      measures: [
        { key: "quantity", label: "Qty Received", type: "number", field: "quantityReceived" },
        { key: "lineCost", label: "Line Cost", type: "decimal", field: "lineCost", cost: true },
      ],
    },
  },
  {
    key: "ServiceCase",
    label: "Service Cases",
    prismaModel: "serviceCase",
    columns: [
      { field: "id", label: "ID", type: "number" },
      { field: "caseNumber", label: "Case #", type: "string" },
      { field: "summary", label: "Summary", type: "string" },
      { field: "storeLocation", label: "Store", type: "string" },
      { field: "itemDescription", label: "Item", type: "string" },
      { field: "partNo", label: "Part #", type: "string" },
      { field: "created", label: "Opened", type: "date" },
      { field: "resolvedAt", label: "Resolved", type: "date" },
    ],
    joins: [
      {
        relation: "status",
        label: "Status",
        columns: [{ field: "status.name", label: "Status", type: "string" }],
      },
      {
        relation: "type",
        label: "Type",
        columns: [{ field: "type.name", label: "Type", type: "string" }],
      },
      {
        relation: "priority",
        label: "Priority",
        columns: [{ field: "priority.name", label: "Priority", type: "string" }],
      },
      {
        relation: "customer",
        label: "Customer",
        columns: [
          { field: "customer.firstName", label: "First Name", type: "string" },
          { field: "customer.lastName", label: "Last Name", type: "string" },
        ],
      },
      {
        relation: "vendor",
        label: "Vendor",
        columns: [{ field: "vendor.name", label: "Vendor Name", type: "string" }],
      },
      {
        relation: "salesOrder",
        label: "Sales Order",
        columns: [{ field: "salesOrder.orderno", label: "Order #", type: "string" }],
      },
      {
        relation: "assignedTo",
        label: "Assigned To",
        columns: [{ field: "assignedTo.displayName", label: "Assigned To", type: "string" }],
      },
    ],
    filters: [
      { field: "caseNumber", label: "Case #", type: "string" },
      { field: "status.name", label: "Status", type: "string" },
      { field: "type.name", label: "Type", type: "string" },
      { field: "storeLocation", label: "Store", type: "string", nullable: true },
      { field: "created", label: "Opened", type: "date" },
      { field: "resolvedAt", label: "Resolved", type: "date", nullable: true },
    ],
    defaultOrderBy: "created",
    totals: {
      where: {},
      says: "Every case, open or closed. Group by status to separate them.",
      countLabel: "Cases",
      groups: [
        { key: "status", label: "Status", path: "status.name" },
        { key: "type", label: "Type", path: "type.name" },
        { key: "priority", label: "Priority", path: "priority.name" },
        { key: "vendor", label: "Vendor", path: "vendor.name" },
        { key: "assignedTo", label: "Assigned to", path: "assignedTo.displayName" },
        { key: "store", label: "Store", path: "storeLocation" },
        { key: "openedMonth", label: "Month opened", path: "created", bucket: "month" },
      ],
      measures: [],
    },
  },
  {
    key: "InventoryTransfer",
    label: "Stock Transfers",
    prismaModel: "inventoryTransfer",
    columns: [
      { field: "id", label: "ID", type: "number" },
      { field: "quantity", label: "Qty", type: "decimal" },
      { field: "receivedQuantity", label: "Qty Received", type: "decimal" },
      { field: "fromLocation", label: "From", type: "string" },
      { field: "toLocation", label: "To", type: "string" },
      { field: "status", label: "Status", type: "string" },
      { field: "created", label: "Requested", type: "date" },
      { field: "shippedAt", label: "Shipped", type: "date" },
      { field: "receivedAt", label: "Received", type: "date" },
    ],
    joins: [
      {
        relation: "product",
        label: "Product",
        columns: [
          { field: "product.productNumber", label: "Product Number", type: "string" },
          { field: "product.name", label: "Product Name", type: "string" },
        ],
      },
      {
        relation: "salesOrder",
        label: "Sales Order",
        columns: [{ field: "salesOrder.orderno", label: "Order #", type: "string" }],
      },
    ],
    filters: [
      {
        field: "status",
        label: "Status",
        type: "select",
        options: ["DRAFT", "IN_TRANSIT", "RECEIVED", "CANCELLED"],
      },
      { field: "fromLocation", label: "From", type: "string" },
      { field: "toLocation", label: "To", type: "string" },
      { field: "created", label: "Requested", type: "date" },
      { field: "receivedAt", label: "Received", type: "date", nullable: true },
    ],
    defaultOrderBy: "created",
    totals: {
      where: { status: { not: "CANCELLED" } },
      says: "Leaves out cancelled transfers.",
      countLabel: "Transfers",
      groups: [
        { key: "status", label: "Status", path: "status" },
        { key: "from", label: "From", path: "fromLocation" },
        { key: "to", label: "To", path: "toLocation" },
        { key: "vendor", label: "Vendor", path: "product.vendor.name" },
        { key: "requestedMonth", label: "Month requested", path: "created", bucket: "month" },
      ],
      measures: [
        { key: "quantity", label: "Qty", type: "number", field: "quantity" },
        { key: "received", label: "Qty Received", type: "number", field: "receivedQuantity" },
      ],
    },
  },
];

export function getEntityDef(key: string): EntityDef | undefined {
  return ENTITIES.find((e) => e.key === key);
}

/** The entity as this caller may see it: what the store pays is gone without View cost. */
export function entityFor(entity: EntityDef, canSeeCost: boolean): EntityDef {
  if (canSeeCost) return entity;
  return {
    ...entity,
    columns: entity.columns.filter((c) => !c.cost),
    joins: entity.joins.map((j) => ({ ...j, columns: j.columns.filter((c) => !c.cost) })),
    totals: { ...entity.totals, measures: entity.totals.measures.filter((m) => !m.cost) },
  };
}
