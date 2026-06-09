-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "VendorPricingModel" AS ENUM ('FLAT', 'GRADE_BASED', 'FRAME_PLUS_CUSHION', 'SPECIES_MATRIX', 'MULTI_AXIS', 'AREA_BASED', 'SIZE_BASED');

-- CreateEnum
CREATE TYPE "PriceType" AS ENUM ('COST', 'WHOLESALE', 'RETAIL', 'MSRP', 'MAP', 'STOCKING');

-- CreateEnum
CREATE TYPE "DimensionType" AS ENUM ('FABRIC_GRADE', 'LEATHER_GRADE', 'WOOD_SPECIES', 'FINISH_TIER', 'CUSHION_GRADE', 'SIZE', 'MATERIAL_TIER', 'CUSTOM');

-- CreateEnum
CREATE TYPE "SurchargeType" AS ENUM ('FLAT', 'PERCENTAGE', 'PER_UNIT');

-- CreateEnum
CREATE TYPE "InventoryTransferStatus" AS ENUM ('DRAFT', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LocationType" AS ENUM ('STORE', 'WAREHOUSE', 'OFFSITE');

-- CreateEnum
CREATE TYPE "DeliveryMethod" AS ENUM ('TAKEN', 'DELIVERY', 'PICKUP');

-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'CONFIRMED', 'RECEIVED_PARTIAL', 'RECEIVED_FULL', 'SHORT_CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BuyerDraftItemStatus" AS ENUM ('DRAFT', 'READY', 'EXPORTED', 'FULFILLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BuyerDraftPoStatus" AS ENUM ('DRAFT', 'READY', 'EXPORTED', 'FULFILLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BuyerDraftSource" AS ENUM ('MANUAL', 'HD_PROPOSAL', 'APPAREL_SCAN', 'CONFIGURATOR', 'HISTORICAL_PO_IMPORT');

-- CreateEnum
CREATE TYPE "BuyerDraftItemType" AS ENUM ('UPHOLSTERY', 'CASE_GOODS', 'OTHER');

-- CreateEnum
CREATE TYPE "BuyerDraftPoLinkSource" AS ENUM ('AUTO', 'MANUAL', 'HISTORICAL_IMPORT');

-- CreateEnum
CREATE TYPE "BuyerDraftBuyStatus" AS ENUM ('PLANNING', 'OPEN', 'EXPORTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "JournalType" AS ENUM ('SALES', 'PURCHASING');

-- CreateEnum
CREATE TYPE "JournalStatus" AS ENUM ('DRAFT', 'POSTED', 'EXPORTED');

-- CreateEnum
CREATE TYPE "SalesOrderStatus" AS ENUM ('QUOTE', 'ORDER', 'FULFILLED', 'CANCELLED', 'RETURNED');

-- CreateEnum
CREATE TYPE "LineItemStatus" AS ENUM ('ACTIVE', 'CANCELLED', 'BACKORDERED', 'REPLACED');

-- CreateEnum
CREATE TYPE "DispatchStatus" AS ENUM ('PO_PLACED', 'RECEIVED_IN_WAREHOUSE', 'READY_FOR_PICKUP', 'SCHEDULED_DELIVERY', 'FULFILLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'COMPLETED', 'REFUNDED', 'VOIDED', 'FAILED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'CARD', 'CHECK', 'GIFT_CARD', 'STORE_CREDIT', 'WIRE', 'ACH', 'FINANCE', 'OTHER');

-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'DESIGNER', 'REGISTER', 'MANAGER', 'WAREHOUSE', 'INSTALLER', 'MARKETING');

-- CreateEnum
CREATE TYPE "ServiceAppointmentType" AS ENUM ('MEASURE', 'INSTALL', 'DELIVERY', 'HOUSE_CALL');

-- CreateEnum
CREATE TYPE "ServiceAppointmentStatus" AS ENUM ('PENDING', 'SCHEDULED', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InteractionOutcome" AS ENUM ('BROWSING', 'QUOTE_STARTED', 'SALE_COMPLETED', 'APPOINTMENT_SET', 'SERVICE_CASE', 'RETURNED');

-- CreateEnum
CREATE TYPE "UpBoardStatus" AS ENUM ('UP', 'WITH_CUSTOMER', 'ON_BREAK', 'AVAILABLE');

-- CreateEnum
CREATE TYPE "GiftCardStatus" AS ENUM ('ACTIVE', 'REDEEMED', 'VOIDED');

-- CreateEnum
CREATE TYPE "GiftCardTransactionType" AS ENUM ('ISSUANCE', 'REDEMPTION', 'RELOAD', 'ADJUSTMENT', 'VOID', 'IMPORT');

-- CreateEnum
CREATE TYPE "TillStatus" AS ENUM ('OPEN', 'CLOSED', 'RECONCILED');

-- CreateEnum
CREATE TYPE "CreditTransactionType" AS ENUM ('REFUND_CREDIT', 'USAGE', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "CustomerLedgerEntryType" AS ENUM ('SALE', 'PAYMENT', 'REFUND_ISSUED', 'DEPOSIT_RECEIVED', 'DEPOSIT_APPLIED', 'ADJUSTMENT_DEBIT', 'ADJUSTMENT_CREDIT');

-- CreateEnum
CREATE TYPE "ServiceTaskStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReturnStatus" AS ENUM ('INITIATED', 'PICKUP_SCHEDULED', 'PICKUP_COMPLETED', 'RECEIVED', 'INSPECTED', 'RESTOCKED', 'WRITTEN_OFF', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReturnReason" AS ENUM ('DEFECTIVE', 'DAMAGED_IN_DELIVERY', 'WRONG_ITEM', 'CUSTOMER_CHANGED_MIND', 'NOT_AS_DESCRIBED', 'DUPLICATE_ORDER', 'OTHER');

-- CreateEnum
CREATE TYPE "InspectionCondition" AS ENUM ('LIKE_NEW', 'MINOR_DAMAGE', 'MAJOR_DAMAGE', 'UNSALVAGEABLE');

-- CreateEnum
CREATE TYPE "VehicleType" AS ENUM ('BOX_TRUCK', 'VAN', 'RENTAL');

-- CreateEnum
CREATE TYPE "DeliveryRunStatus" AS ENUM ('PLANNING', 'LOADED', 'IN_PROGRESS', 'COMPLETED');

-- CreateEnum
CREATE TYPE "DeliveryStopStatus" AS ENUM ('PENDING', 'EN_ROUTE', 'ARRIVED', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "PickListStatus" AS ENUM ('CREATED', 'IN_PROGRESS', 'COMPLETED');

-- CreateEnum
CREATE TYPE "ConsignmentItemStatus" AS ENUM ('ON_FLOOR', 'ON_APPROVAL', 'SOLD', 'RETURNED_VENDOR', 'MISSING', 'PAID');

-- CreateEnum
CREATE TYPE "ConsignmentVendorReturnStatus" AS ENUM ('PENDING', 'CONFIRMED');

-- CreateEnum
CREATE TYPE "LeadSource" AS ENUM ('MAILCHIMP_CLICK', 'MAILCHIMP_OPEN', 'WALK_IN', 'PHONE', 'REFERRAL', 'WEBSITE', 'OTHER');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'ASSIGNED', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'LOST');

-- CreateEnum
CREATE TYPE "InventoryFreezeStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED');

-- CreateTable
CREATE TABLE "Vendor" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "pricingModel" "VendorPricingModel" NOT NULL DEFAULT 'FLAT',
    "defaultMarkup" DECIMAL(65,30),
    "defaultDiscount" DECIMAL(65,30),
    "cost_multiplier" DECIMAL(65,30),
    "mapEnforced" BOOLEAN NOT NULL DEFAULT false,
    "website" TEXT,
    "accountNumber" TEXT,
    "paymentTerms" TEXT,
    "freightTerms" TEXT,
    "minimumOrder" DECIMAL(65,30),
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "zip" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "notes" TEXT,
    "allowTradeDiscount" BOOLEAN NOT NULL DEFAULT true,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorContact" (
    "id" SERIAL NOT NULL,
    "vendorId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "role" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "VendorContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorStyle" (
    "id" SERIAL NOT NULL,
    "styleNumber" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "vendorId" INTEGER NOT NULL,
    "departmentId" INTEGER,
    "categoryId" INTEGER,
    "typeId" INTEGER,
    "collectionId" INTEGER,
    "baseCost" DECIMAL(65,30),
    "baseRetail" DECIMAL(65,30),
    "mapPrice" DECIMAL(65,30),
    "comYardage" DECIMAL(65,30),
    "comYardagePattern" DECIMAL(65,30),
    "comYardageRepeat" DECIMAL(65,30),
    "gradeRiser" DECIMAL(65,30),
    "standardSeat" TEXT,
    "standardBack" TEXT,
    "standardPillows" TEXT,
    "finish" TEXT,
    "framePrice" DECIMAL(65,30),
    "cushionRef" TEXT,
    "pricePerSqFt" DECIMAL(65,30),
    "pricePerSqYd" DECIMAL(65,30),
    "length" DOUBLE PRECISION,
    "width" DOUBLE PRECISION,
    "depth" DOUBLE PRECISION,
    "height" DOUBLE PRECISION,
    "seatHeight" DOUBLE PRECISION,
    "armHeight" DOUBLE PRECISION,
    "seatDepth" DOUBLE PRECISION,
    "weight" DOUBLE PRECISION,
    "imageUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDiscontinued" BOOLEAN NOT NULL DEFAULT false,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "VendorStyle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" SERIAL NOT NULL,
    "externalId" INTEGER,
    "productNumber" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "vendorId" INTEGER NOT NULL,
    "departmentId" INTEGER NOT NULL,
    "categoryId" INTEGER NOT NULL,
    "typeId" INTEGER,
    "collectionId" INTEGER,
    "vendorStyleId" INTEGER,
    "configSnapshot" TEXT,
    "baseCost" DECIMAL(65,30),
    "baseRetail" DECIMAL(65,30),
    "mapPrice" DECIMAL(65,30),
    "length" DOUBLE PRECISION,
    "width" DOUBLE PRECISION,
    "depth" DOUBLE PRECISION,
    "height" DOUBLE PRECISION,
    "seatHeight" DOUBLE PRECISION,
    "armHeight" DOUBLE PRECISION,
    "seatDepth" DOUBLE PRECISION,
    "weight" DOUBLE PRECISION,
    "cubicFeet" DOUBLE PRECISION,
    "imageUrl" TEXT,
    "freightClass" TEXT,
    "shipsVia" TEXT,
    "cartonQty" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDiscontinued" BOOLEAN NOT NULL DEFAULT false,
    "season" TEXT,
    "comYardage" DECIMAL(65,30),
    "comYardagePattern" DECIMAL(65,30),
    "comYardageRepeat" DECIMAL(65,30),
    "gradeRiser" DECIMAL(65,30),
    "standardSeat" TEXT,
    "standardBack" TEXT,
    "standardPillows" TEXT,
    "framePrice" DECIMAL(65,30),
    "cushionRef" TEXT,
    "pricePerSqFt" DECIMAL(65,30),
    "pricePerSqYd" DECIMAL(65,30),
    "serviceType" "ServiceAppointmentType",
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Collection" (
    "id" SERIAL NOT NULL,
    "vendorId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "Collection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductVariant" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "sku" TEXT,
    "upc" TEXT,
    "size" TEXT,
    "color" TEXT,
    "finish" TEXT,
    "material" TEXT,
    "cost" DECIMAL(65,30),
    "wholesale" DECIMAL(65,30),
    "retail" DECIMAL(65,30),
    "mapPrice" DECIMAL(65,30),
    "width" DECIMAL(65,30),
    "length" DECIMAL(65,30),
    "height" DECIMAL(65,30),
    "weight" DECIMAL(65,30),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceList" (
    "id" SERIAL NOT NULL,
    "vendorId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "expiresDate" TIMESTAMP(3),
    "priceType" "PriceType" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sourceFile" TEXT,
    "notes" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "PriceList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorPriceDimension" (
    "id" SERIAL NOT NULL,
    "vendorId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "dimensionType" "DimensionType" NOT NULL,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "VendorPriceDimension_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceDimensionTier" (
    "id" SERIAL NOT NULL,
    "dimensionId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "unitPrice" DECIMAL(65,30),
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),

    CONSTRAINT "PriceDimensionTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FabricCatalog" (
    "id" SERIAL NOT NULL,
    "vendorId" INTEGER NOT NULL,
    "tierId" INTEGER NOT NULL,
    "fabricName" TEXT NOT NULL,
    "fabricCode" TEXT,
    "colorName" TEXT NOT NULL DEFAULT '',
    "colorCode" TEXT,
    "patternRepeat" TEXT,
    "width" TEXT,
    "content" TEXT,
    "collection" TEXT,
    "usage" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDiscontinued" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "imageUrl" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "FabricCatalog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductGradePrice" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "tierId" INTEGER NOT NULL,
    "cost" DECIMAL(65,30),
    "wholesale" DECIMAL(65,30),
    "retail" DECIMAL(65,30),
    "msrp" DECIMAL(65,30),
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),

    CONSTRAINT "ProductGradePrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductSpeciesPrice" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "tierId" INTEGER NOT NULL,
    "cost" DECIMAL(65,30),
    "wholesale" DECIMAL(65,30),
    "retail" DECIMAL(65,30),
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),

    CONSTRAINT "ProductSpeciesPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductAxisPrice" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "tier1Id" INTEGER NOT NULL,
    "tier2Id" INTEGER,
    "tier3Id" INTEGER,
    "cost" DECIMAL(65,30),
    "wholesale" DECIMAL(65,30),
    "retail" DECIMAL(65,30),
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),

    CONSTRAINT "ProductAxisPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StyleGradePrice" (
    "id" SERIAL NOT NULL,
    "vendorStyleId" INTEGER NOT NULL,
    "tierId" INTEGER NOT NULL,
    "cost" DECIMAL(65,30),
    "wholesale" DECIMAL(65,30),
    "retail" DECIMAL(65,30),
    "msrp" DECIMAL(65,30),
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),

    CONSTRAINT "StyleGradePrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StyleSpeciesPrice" (
    "id" SERIAL NOT NULL,
    "vendorStyleId" INTEGER NOT NULL,
    "tierId" INTEGER NOT NULL,
    "cost" DECIMAL(65,30),
    "wholesale" DECIMAL(65,30),
    "retail" DECIMAL(65,30),
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),

    CONSTRAINT "StyleSpeciesPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StyleAxisPrice" (
    "id" SERIAL NOT NULL,
    "vendorStyleId" INTEGER NOT NULL,
    "tier1Id" INTEGER NOT NULL,
    "tier2Id" INTEGER,
    "tier3Id" INTEGER,
    "cost" DECIMAL(65,30),
    "wholesale" DECIMAL(65,30),
    "retail" DECIMAL(65,30),
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),

    CONSTRAINT "StyleAxisPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorOptionGroup" (
    "id" SERIAL NOT NULL,
    "vendorId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "VendorOptionGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorOption" (
    "id" SERIAL NOT NULL,
    "groupId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "surchargeType" "SurchargeType" NOT NULL DEFAULT 'FLAT',
    "defaultSurcharge" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "requiresTextInput" BOOLEAN NOT NULL DEFAULT false,
    "textInputLabel" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),

    CONSTRAINT "VendorOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductOptionOverride" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "optionId" INTEGER NOT NULL,
    "surcharge" DECIMAL(65,30),
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "isStandard" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),

    CONSTRAINT "ProductOptionOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StyleOptionOverride" (
    "id" SERIAL NOT NULL,
    "vendorStyleId" INTEGER NOT NULL,
    "optionId" INTEGER NOT NULL,
    "surcharge" DECIMAL(65,30),
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "isStandard" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),

    CONSTRAINT "StyleOptionOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorProgram" (
    "id" SERIAL NOT NULL,
    "vendorId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "discountType" "SurchargeType",
    "discountValue" DECIMAL(65,30),
    "minOrderValue" DECIMAL(65,30),
    "minAnnualValue" DECIMAL(65,30),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "VendorProgram_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Department" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "departmentId" INTEGER NOT NULL,
    "labelTemplateId" INTEGER,
    "trackInventory" BOOLEAN NOT NULL DEFAULT true,
    "accountGroupId" INTEGER,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Type" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "categoryId" INTEGER NOT NULL,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "Type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabelTemplate" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "context" TEXT NOT NULL,
    "tagSize" TEXT NOT NULL,
    "zplTemplate" TEXT NOT NULL,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "LabelTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Printer" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 9100,
    "location" TEXT,
    "tagType" TEXT NOT NULL,
    "store" TEXT,
    "supportedSizes" TEXT[],
    "currentSize" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "Printer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Upc" (
    "id" SERIAL NOT NULL,
    "upc" TEXT NOT NULL,
    "productId" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'SYSTEM',
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "Upc_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "emailVerified" TIMESTAMP(3),
    "image" TEXT,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" SERIAL NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "taxExempt" BOOLEAN NOT NULL DEFAULT false,
    "taxExemptReasonId" INTEGER,
    "defaultTaxDistrictId" INTEGER,
    "creditBalance" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "openArBalance" DECIMAL(65,30) DEFAULT 0,
    "isTradeAccount" BOOLEAN NOT NULL DEFAULT false,
    "tradeCompanyName" TEXT,
    "tradeTierId" INTEGER,
    "taxExemptNumber" TEXT,
    "customerLevel" INTEGER,
    "peakCustomerLevel" INTEGER,
    "customerGroup" TEXT,
    "lifetimeSpend" DECIMAL(65,30) DEFAULT 0,
    "lifetimeOrderCount" INTEGER DEFAULT 0,
    "firstOrderDate" TIMESTAMP(3),
    "lastOrderDate" TIMESTAMP(3),
    "departmentCount" INTEGER DEFAULT 0,
    "mailchimpSyncedAt" TIMESTAMP(3),
    "primaryDesignerId" INTEGER,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerAddress" (
    "id" SERIAL NOT NULL,
    "customerId" INTEGER NOT NULL,
    "label" TEXT,
    "address1" TEXT NOT NULL,
    "address2" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "zip" TEXT NOT NULL,
    "notes" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "CustomerAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerExternalId" (
    "id" SERIAL NOT NULL,
    "externalId" TEXT NOT NULL,
    "customerId" INTEGER NOT NULL,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "CustomerExternalId_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WindfallEnrichment" (
    "id" SERIAL NOT NULL,
    "customerId" INTEGER NOT NULL,
    "windfallId" TEXT,
    "matchConfidence" DECIMAL(65,30),
    "netWorth" INTEGER,
    "netWorthLow" INTEGER,
    "netWorthHigh" INTEGER,
    "wealthTier" TEXT,
    "netWorthLastCalculated" TIMESTAMP(3),
    "recentMover" BOOLEAN NOT NULL DEFAULT false,
    "recentlyDivorced" BOOLEAN NOT NULL DEFAULT false,
    "recentDeathInFamily" BOOLEAN NOT NULL DEFAULT false,
    "moneyInMotion" BOOLEAN NOT NULL DEFAULT false,
    "liquidityTrigger" BOOLEAN NOT NULL DEFAULT false,
    "recentMortgage" BOOLEAN NOT NULL DEFAULT false,
    "boatOwner" BOOLEAN NOT NULL DEFAULT false,
    "planeOwner" BOOLEAN NOT NULL DEFAULT false,
    "multiPropertyOwner" BOOLEAN NOT NULL DEFAULT false,
    "rentalPropertyOwner" BOOLEAN NOT NULL DEFAULT false,
    "smallBusinessOwner" BOOLEAN NOT NULL DEFAULT false,
    "cryptoInterest" BOOLEAN NOT NULL DEFAULT false,
    "philanthropicGiver" BOOLEAN NOT NULL DEFAULT false,
    "topPhilanthropicDonor" BOOLEAN NOT NULL DEFAULT false,
    "nonprofitBoardMember" BOOLEAN NOT NULL DEFAULT false,
    "donorAdvisedFunds" BOOLEAN NOT NULL DEFAULT false,
    "nteeCodes" TEXT,
    "regionalFocus" TEXT,
    "foundationAssociation" BOOLEAN NOT NULL DEFAULT false,
    "foundationOfficer" BOOLEAN NOT NULL DEFAULT false,
    "politicalDonor" BOOLEAN NOT NULL DEFAULT false,
    "topPoliticalDonor" BOOLEAN NOT NULL DEFAULT false,
    "politicalParty" TEXT,
    "hasHouseholdDebt" BOOLEAN NOT NULL DEFAULT false,
    "primaryPropertyLtv" DECIMAL(65,30),
    "trustAssociation" BOOLEAN NOT NULL DEFAULT false,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "WindfallEnrichment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailchimpActivity" (
    "id" SERIAL NOT NULL,
    "customerId" INTEGER,
    "email" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailchimpActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailchimpCampaign" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "subject" TEXT,
    "sentAt" TIMESTAMP(3),
    "activityLastSyncedAt" TIMESTAMP(3),

    CONSTRAINT "MailchimpCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailchimpCampaignStats" (
    "id" SERIAL NOT NULL,
    "campaignId" TEXT NOT NULL,
    "emailsSent" INTEGER NOT NULL,
    "opens" INTEGER NOT NULL,
    "uniqueOpens" INTEGER NOT NULL,
    "clicks" INTEGER NOT NULL,
    "uniqueClicks" INTEGER NOT NULL,
    "bounces" INTEGER NOT NULL,
    "unsubscribed" INTEGER NOT NULL,
    "lastUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailchimpCampaignStats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignTarget" (
    "id" SERIAL NOT NULL,
    "tileId" TEXT NOT NULL,
    "customerId" INTEGER NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentBy" TEXT,
    "notes" TEXT,

    CONSTRAINT "CampaignTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductPairing" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "fromDepartmentId" INTEGER NOT NULL,
    "fromCategoryId" INTEGER,
    "toDepartmentId" INTEGER NOT NULL,
    "toCategoryId" INTEGER,
    "windowDays" INTEGER NOT NULL DEFAULT 60,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "ProductPairing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailchimpSyncLog" (
    "id" SERIAL NOT NULL,
    "runId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "campaignsUpserted" INTEGER NOT NULL DEFAULT 0,
    "metricsUpdated" INTEGER NOT NULL DEFAULT 0,
    "activitiesInserted" INTEGER NOT NULL DEFAULT 0,
    "leadsCreated" INTEGER NOT NULL DEFAULT 0,
    "leadsUpdated" INTEGER NOT NULL DEFAULT 0,
    "leadsArchived" INTEGER NOT NULL DEFAULT 0,
    "errors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailchimpSyncLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonthlySalesPercentage" (
    "id" SERIAL NOT NULL,
    "year" INTEGER NOT NULL,
    "month" TEXT NOT NULL,
    "percentage" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "MonthlySalesPercentage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesGoals" (
    "id" SERIAL NOT NULL,
    "year" INTEGER NOT NULL,
    "goalType" TEXT NOT NULL,
    "entityName" TEXT NOT NULL,
    "annualGoal" DOUBLE PRECISION NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesGoals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhysicalInventoryCount" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "stockLocation" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "countedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,

    CONSTRAINT "PhysicalInventoryCount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventorySnapshot" (
    "id" SERIAL NOT NULL,
    "externalId" INTEGER NOT NULL,
    "stockLocation" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "snapshotDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventorySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reconciliation" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "location" TEXT NOT NULL,
    "initialExpected" INTEGER NOT NULL,
    "initialCounted" INTEGER NOT NULL,
    "initialVariance" INTEGER NOT NULL,
    "actionTaken" TEXT NOT NULL,
    "finalCount" INTEGER NOT NULL,
    "finalVariance" INTEGER NOT NULL,
    "reconciledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reconciledByUserId" TEXT NOT NULL,

    CONSTRAINT "Reconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnidentifiedScan" (
    "id" SERIAL NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "notes" TEXT,
    "countedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reconciliationStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "countedByUserId" TEXT,
    "reconciledProductId" INTEGER,
    "reconciledAt" TIMESTAMP(3),

    CONSTRAINT "UnidentifiedScan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreLocation" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" "LocationType" NOT NULL,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "zip" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "externalLocationName" TEXT,
    "defaultReceivingStockLocationId" INTEGER,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "StoreLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockLocation" (
    "id" SERIAL NOT NULL,
    "storeLocationId" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "building" TEXT,
    "floor" INTEGER,
    "area" INTEGER,
    "locationType" TEXT NOT NULL DEFAULT 'STOCK',
    "squareFootage" INTEGER,
    "locationAliases" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "StockLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryPosition" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "storeLocationId" INTEGER NOT NULL,
    "stockLocationId" INTEGER,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "salesOrderId" INTEGER,
    "notes" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "InventoryPosition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryZone" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "baseFee" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "perPieceFee" DECIMAL(65,30),
    "isThirdParty" BOOLEAN NOT NULL DEFAULT false,
    "carrierName" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "DeliveryZone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryZoneZip" (
    "id" SERIAL NOT NULL,
    "deliveryZoneId" INTEGER NOT NULL,
    "zipCode" TEXT NOT NULL,

    CONSTRAINT "DeliveryZoneZip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryTransfer" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "fromLocation" TEXT NOT NULL,
    "toLocation" TEXT NOT NULL,
    "fromLocationId" INTEGER,
    "fromStockLocationId" INTEGER,
    "toLocationId" INTEGER,
    "toStockLocationId" INTEGER,
    "notes" TEXT,
    "requestedByUserId" TEXT NOT NULL,
    "status" "InventoryTransferStatus" NOT NULL DEFAULT 'DRAFT',
    "shippedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "receivedByUserId" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),

    CONSTRAINT "InventoryTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" SERIAL NOT NULL,
    "poNumber" TEXT NOT NULL,
    "vendorId" INTEGER NOT NULL,
    "salesOrderId" INTEGER,
    "orderDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expectedDelivery" TIMESTAMP(3),
    "estimatedShipDate" TIMESTAMP(3),
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "vendorAckNumber" TEXT,
    "vendorAckDate" TIMESTAMP(3),
    "notes" TEXT,
    "isReturn" BOOLEAN NOT NULL DEFAULT false,
    "returnId" INTEGER,
    "vendorReference" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderItem" (
    "id" SERIAL NOT NULL,
    "purchaseOrderId" INTEGER NOT NULL,
    "productId" INTEGER,
    "orderLineItemId" INTEGER,
    "orderedQuantity" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "unitCost" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "externalPorNo" TEXT,
    "partNo" TEXT,
    "productName" TEXT,
    "productVariantId" INTEGER,
    "vendorStyleId" INTEGER,
    "selectedGrade" TEXT,
    "selectedFinish" TEXT,
    "selectedOptions" TEXT,

    CONSTRAINT "PurchaseOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceivingRecord" (
    "id" SERIAL NOT NULL,
    "purchaseOrderItemId" INTEGER NOT NULL,
    "purchaseOrderId" INTEGER NOT NULL,
    "quantityReceived" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "receivedDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receiverUserId" TEXT NOT NULL,
    "destinationLocation" TEXT,
    "destinationLocationId" INTEGER,
    "destinationStockLocationId" INTEGER,
    "condition" TEXT,
    "tagsPrinted" BOOLEAN NOT NULL DEFAULT false,
    "externalGipNo" TEXT,
    "externalPorNo" TEXT,
    "lineCost" DECIMAL(65,30),
    "invoiceNumber" TEXT,

    CONSTRAINT "ReceivingRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuyerDraftPurchaseOrder" (
    "id" SERIAL NOT NULL,
    "vendorId" INTEGER,
    "vendorName" TEXT NOT NULL,
    "referenceNumber" TEXT,
    "expectedShipMonth" TIMESTAMP(3),
    "expectedDeliveryDate" TIMESTAMP(3),
    "storeLocationId" INTEGER,
    "buyId" INTEGER,
    "notes" TEXT,
    "status" "BuyerDraftPoStatus" NOT NULL DEFAULT 'DRAFT',
    "exportedAt" TIMESTAMP(3),
    "exportBatchId" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "BuyerDraftPurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuyerDraftPoRealPoLink" (
    "id" SERIAL NOT NULL,
    "draftPoId" INTEGER NOT NULL,
    "realPoId" INTEGER NOT NULL,
    "linkSource" "BuyerDraftPoLinkSource" NOT NULL DEFAULT 'AUTO',
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "BuyerDraftPoRealPoLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuyerDraftBuy" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "season" TEXT,
    "year" INTEGER,
    "budget" DECIMAL(65,30),
    "status" "BuyerDraftBuyStatus" NOT NULL DEFAULT 'PLANNING',
    "kickoff" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "notes" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "BuyerDraftBuy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuyerDraftItem" (
    "id" SERIAL NOT NULL,
    "vendorId" INTEGER,
    "vendorName" TEXT NOT NULL,
    "partNumber" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "cost" DECIMAL(65,30) NOT NULL,
    "msrp" DECIMAL(65,30),
    "retail" DECIMAL(65,30) NOT NULL,
    "description" TEXT,
    "vendorStyleId" INTEGER,
    "configuration" JSONB,
    "itemType" "BuyerDraftItemType" NOT NULL DEFAULT 'OTHER',
    "grade" TEXT,
    "fabric" TEXT,
    "finish" TEXT,
    "cushions" TEXT,
    "cleaningCode" TEXT,
    "tossPillows" TEXT,
    "hardware" TEXT,
    "hardwareFinish" TEXT,
    "options" TEXT,
    "departmentId" INTEGER,
    "categoryId" INTEGER,
    "typeId" INTEGER,
    "productWidth" DECIMAL(65,30),
    "productLength" DECIMAL(65,30),
    "productHeight" DECIMAL(65,30),
    "stockProgram" BOOLEAN NOT NULL DEFAULT false,
    "stockFamily" TEXT,
    "vignette" TEXT,
    "draftPoId" INTEGER,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "stockLocationId" INTEGER,
    "barcode" TEXT,
    "status" "BuyerDraftItemStatus" NOT NULL DEFAULT 'DRAFT',
    "source" "BuyerDraftSource" NOT NULL DEFAULT 'MANUAL',
    "exportedAt" TIMESTAMP(3),
    "exportBatchId" TEXT,
    "fulfilledAt" TIMESTAMP(3),
    "fulfilledProductId" INTEGER,
    "notes" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "BuyerDraftItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GLAccount" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accountType" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "GLAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountGroup" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "cogsAccountId" INTEGER,
    "inventoryAccountId" INTEGER,
    "salesAccountId" INTEGER,
    "returnsAccountId" INTEGER,
    "transfersAccountId" INTEGER,
    "shrinkageAccountId" INTEGER,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "AccountGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemGLMapping" (
    "id" SERIAL NOT NULL,
    "section" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "glAccountId" INTEGER,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "SystemGLMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyReconciliationLog" (
    "id" SERIAL NOT NULL,
    "date" DATE NOT NULL,
    "sourceRevenue" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "sourceTax" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "sourceCost" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "sourceCash" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "journalRevenue" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "journalTax" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "journalCost" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "journalCash" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "driftRevenue" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "driftTax" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "driftCost" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "driftCash" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "balanced" BOOLEAN NOT NULL,
    "warnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "journalEntryId" INTEGER,
    "durationMs" INTEGER,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "DailyReconciliationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" SERIAL NOT NULL,
    "journalNumber" TEXT NOT NULL,
    "journalDate" TIMESTAMP(3) NOT NULL,
    "journalType" "JournalType" NOT NULL DEFAULT 'SALES',
    "status" "JournalStatus" NOT NULL DEFAULT 'DRAFT',
    "storeLocation" TEXT,
    "storeLocationId" INTEGER,
    "totalDebits" DECIMAL(65,30) NOT NULL,
    "totalCredits" DECIMAL(65,30) NOT NULL,
    "notes" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntryLine" (
    "id" SERIAL NOT NULL,
    "journalEntryId" INTEGER NOT NULL,
    "glAccountId" INTEGER NOT NULL,
    "memo" TEXT NOT NULL,
    "debit" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "credit" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),

    CONSTRAINT "JournalEntryLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxDistrict" (
    "id" SERIAL NOT NULL,
    "shortName" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "authority" TEXT,
    "name" TEXT NOT NULL,
    "reference" TEXT,
    "glAccountId" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "TaxDistrict_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxDistrictZipCode" (
    "id" SERIAL NOT NULL,
    "districtId" INTEGER NOT NULL,
    "zipCode" TEXT NOT NULL,
    "name" TEXT,

    CONSTRAINT "TaxDistrictZipCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxExemptReason" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "TaxExemptReason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxGroup" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "taxBasis" TEXT NOT NULL DEFAULT 'NET',
    "freightTaxable" BOOLEAN NOT NULL DEFAULT false,
    "miscTaxable" BOOLEAN NOT NULL DEFAULT false,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),

    CONSTRAINT "TaxGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxRule" (
    "id" SERIAL NOT NULL,
    "districtId" INTEGER NOT NULL,
    "groupId" INTEGER NOT NULL,
    "taxRate" DECIMAL(65,30) NOT NULL,
    "triggerPrice" DECIMAL(65,30),
    "startPrice" DECIMAL(65,30),
    "stopPrice" DECIMAL(65,30),
    "taxIncludedInSalesPrice" BOOLEAN NOT NULL DEFAULT false,
    "ruleToAddBeforeCalcId" INTEGER,
    "triggerStop" DECIMAL(65,30),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "TaxRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesOrder" (
    "id" SERIAL NOT NULL,
    "orderno" TEXT NOT NULL,
    "orderDate" TIMESTAMP(3),
    "status" "SalesOrderStatus" NOT NULL DEFAULT 'QUOTE',
    "customerId" INTEGER,
    "salesperson" TEXT,
    "salesPersonId" INTEGER,
    "splitWithId" INTEGER,
    "storeLocation" TEXT,
    "storeLocationId" INTEGER,
    "totalTax" DECIMAL(65,30),
    "totalPaid" DECIMAL(65,30),
    "taxDistrictId" INTEGER,
    "taxExemptReasonId" INTEGER,
    "orderNotes" TEXT,
    "dispatchStatus" "DispatchStatus" DEFAULT 'PO_PLACED',
    "externalCustomerCode" TEXT,
    "quoteCode" TEXT,
    "quoteDate" TIMESTAMP(3),
    "deliveryMethod" "DeliveryMethod",
    "deliveryAddressId" INTEGER,
    "pickupLocationId" INTEGER,
    "scheduledDeliveryDate" TIMESTAMP(3),
    "deliveryNotes" TEXT,
    "pipelineArchivedAt" TIMESTAMP(3),
    "pipelineNote" TEXT,
    "archiveReason" TEXT,
    "replacedByOrderId" INTEGER,
    "skipSameDayRewriteCleanup" BOOLEAN NOT NULL DEFAULT false,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "SalesOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLineItem" (
    "id" SERIAL NOT NULL,
    "salesOrderId" INTEGER NOT NULL,
    "lineNumber" INTEGER,
    "partNo" TEXT,
    "barcode" TEXT,
    "vatRate" DECIMAL(65,30),
    "vatAmount" DECIMAL(65,30),
    "porNumber" TEXT,
    "productName" TEXT,
    "orderedQuantity" DECIMAL(65,30) NOT NULL,
    "netPrice" DECIMAL(65,30) NOT NULL,
    "cost" DECIMAL(65,30) NOT NULL,
    "productId" INTEGER,
    "taxDistrictId" INTEGER,
    "vendorStyleId" INTEGER,
    "source" TEXT,
    "fulfillment" TEXT,
    "fulfilledQty" DECIMAL(65,30) DEFAULT 0,
    "selectedGrade" TEXT,
    "selectedFinish" TEXT,
    "selectedOptions" TEXT,
    "lineItemStatus" "LineItemStatus" NOT NULL DEFAULT 'ACTIVE',
    "cancelReason" TEXT,
    "replacedByLineItemId" INTEGER,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),

    CONSTRAINT "OrderLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" SERIAL NOT NULL,
    "invoiceNo" TEXT NOT NULL,
    "invoiceDate" TIMESTAMP(3) NOT NULL,
    "taxAmount" DECIMAL(65,30) NOT NULL,
    "salesOrderId" INTEGER NOT NULL,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceLineItem" (
    "id" SERIAL NOT NULL,
    "invoiceId" INTEGER NOT NULL,
    "orderLineItemId" INTEGER NOT NULL,
    "deliveredQuantity" DECIMAL(65,30) NOT NULL,

    CONSTRAINT "InvoiceLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" SERIAL NOT NULL,
    "salesOrderId" INTEGER,
    "paymentDate" TIMESTAMP(3) NOT NULL,
    "paymentType" TEXT NOT NULL,
    "paymentAmount" DECIMAL(65,30) NOT NULL,
    "paymentCode" TEXT,
    "storeLocation" TEXT,
    "storeLocationId" INTEGER,
    "status" "PaymentStatus",
    "method" "PaymentMethod",
    "registerId" INTEGER,
    "tillId" INTEGER,
    "staffMemberId" INTEGER,
    "customerId" INTEGER,
    "processorType" TEXT,
    "processorTxnId" TEXT,
    "processorData" JSONB,
    "cardLast4" TEXT,
    "cardBrand" TEXT,
    "checkNumber" TEXT,
    "giftCardId" INTEGER,
    "isRefund" BOOLEAN NOT NULL DEFAULT false,
    "originalPaymentId" INTEGER,
    "refundReason" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NavPermission" (
    "id" SERIAL NOT NULL,
    "navItem" TEXT NOT NULL,
    "role" "StaffRole" NOT NULL,

    CONSTRAINT "NavPermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffMember" (
    "id" SERIAL NOT NULL,
    "userId" TEXT,
    "displayName" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "email" TEXT,
    "passwordHash" TEXT,
    "role" "StaffRole" NOT NULL DEFAULT 'DESIGNER',
    "defaultStore" TEXT,
    "activeStoreLocationId" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDesigner" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),

    CONSTRAINT "StaffMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesGoal" (
    "id" SERIAL NOT NULL,
    "staffMemberId" INTEGER NOT NULL,
    "fiscalYear" INTEGER NOT NULL,
    "yearlyGoal" DECIMAL(65,30) NOT NULL,
    "bonusRate" DECIMAL(65,30) NOT NULL DEFAULT 0.06,
    "monthlyWeights" JSONB,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "SalesGoal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffShift" (
    "id" SERIAL NOT NULL,
    "staffMemberId" INTEGER NOT NULL,
    "storeLocation" TEXT NOT NULL,
    "storeLocationId" INTEGER,
    "clockIn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clockOut" TIMESTAMP(3),

    CONSTRAINT "StaffShift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UpBoardEntry" (
    "id" SERIAL NOT NULL,
    "staffMemberId" INTEGER NOT NULL,
    "storeLocation" TEXT NOT NULL,
    "storeLocationId" INTEGER,
    "position" INTEGER NOT NULL,
    "status" "UpBoardStatus" NOT NULL DEFAULT 'AVAILABLE',
    "statusSince" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "customerNote" TEXT,

    CONSTRAINT "UpBoardEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SEComponent" (
    "id" SERIAL NOT NULL,
    "vendorId" INTEGER NOT NULL,
    "componentType" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "imageUrl" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "notAvailableInLeather" BOOLEAN NOT NULL DEFAULT false,
    "notAvailableOnSleepers" BOOLEAN NOT NULL DEFAULT false,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "SEComponent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GiftCard" (
    "id" SERIAL NOT NULL,
    "barcode" TEXT NOT NULL,
    "externalCode" TEXT,
    "initialAmount" DECIMAL(65,30) NOT NULL,
    "currentBalance" DECIMAL(65,30) NOT NULL,
    "status" "GiftCardStatus" NOT NULL DEFAULT 'ACTIVE',
    "activatedAt" TIMESTAMP(3),
    "notes" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "GiftCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GiftCardTransaction" (
    "id" SERIAL NOT NULL,
    "giftCardId" INTEGER NOT NULL,
    "transactionType" "GiftCardTransactionType" NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "balanceBefore" DECIMAL(65,30) NOT NULL,
    "balanceAfter" DECIMAL(65,30) NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "GiftCardTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GiftCardPreset" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "amount" DECIMAL(65,30),
    "label" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "GiftCardPreset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Register" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "storeLocationId" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "Register_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Till" (
    "id" SERIAL NOT NULL,
    "registerId" INTEGER NOT NULL,
    "status" "TillStatus" NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "openedById" INTEGER NOT NULL,
    "closedById" INTEGER,
    "openingCash" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "expectedCash" DECIMAL(65,30),
    "actualCash" DECIMAL(65,30),
    "variance" DECIMAL(65,30),
    "notes" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "Till_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TillCount" (
    "id" SERIAL NOT NULL,
    "tillId" INTEGER NOT NULL,
    "denomination" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "isOpening" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "TillCount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerCreditTransaction" (
    "id" SERIAL NOT NULL,
    "customerId" INTEGER NOT NULL,
    "type" "CreditTransactionType" NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "balanceBefore" DECIMAL(65,30) NOT NULL,
    "balanceAfter" DECIMAL(65,30) NOT NULL,
    "paymentId" INTEGER,
    "salesOrderId" INTEGER,
    "reference" TEXT,
    "notes" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "CustomerCreditTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerLedgerEntry" (
    "id" SERIAL NOT NULL,
    "customerId" INTEGER NOT NULL,
    "type" "CustomerLedgerEntryType" NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "balanceBefore" DECIMAL(65,30) NOT NULL,
    "balanceAfter" DECIMAL(65,30) NOT NULL,
    "salesOrderId" INTEGER,
    "paymentId" INTEGER,
    "invoiceId" INTEGER,
    "reference" TEXT,
    "notes" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "CustomerLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceCaseType" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "ServiceCaseType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceCaseStatus" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "isClosed" BOOLEAN NOT NULL DEFAULT false,
    "color" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "ServiceCaseStatus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceCasePriority" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 0,
    "color" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "ServiceCasePriority_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceCase" (
    "id" SERIAL NOT NULL,
    "caseNumber" TEXT NOT NULL,
    "typeId" INTEGER NOT NULL,
    "statusId" INTEGER NOT NULL,
    "priorityId" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "customerId" INTEGER,
    "salesOrderId" INTEGER,
    "purchaseOrderId" INTEGER,
    "vendorId" INTEGER,
    "salesPersonId" INTEGER,
    "assignedToId" INTEGER,
    "storeLocation" TEXT,
    "storeLocationId" INTEGER,
    "preferredContact" TEXT,
    "itemDescription" TEXT,
    "partNo" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNotes" TEXT,
    "externalSource" TEXT,
    "externalSourceId" TEXT,
    "externalSourceLastSeen" TIMESTAMP(3),
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "ServiceCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceCaseNote" (
    "id" SERIAL NOT NULL,
    "caseId" INTEGER NOT NULL,
    "authorId" INTEGER,
    "authorDisplayName" TEXT,
    "note" TEXT NOT NULL,
    "isInternal" BOOLEAN NOT NULL DEFAULT true,
    "externalSource" TEXT,
    "externalSourceId" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "ServiceCaseNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceTask" (
    "id" SERIAL NOT NULL,
    "caseId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "ServiceTaskStatus" NOT NULL DEFAULT 'PENDING',
    "assignedToId" INTEGER,
    "waitingOn" TEXT,
    "dueDate" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "linkedOrderId" INTEGER,
    "linkedPurchaseOrderId" INTEGER,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "ServiceTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailTemplate" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "EmailTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceEmail" (
    "id" SERIAL NOT NULL,
    "caseId" INTEGER NOT NULL,
    "templateId" INTEGER,
    "toAddress" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentBy" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SENT',

    CONSTRAINT "ServiceEmail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerInteraction" (
    "id" SERIAL NOT NULL,
    "staffMemberId" INTEGER NOT NULL,
    "customerId" INTEGER,
    "salesOrderId" INTEGER,
    "storeLocation" TEXT NOT NULL,
    "storeLocationId" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'WALK_IN',
    "outcome" "InteractionOutcome",
    "notes" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "CustomerInteraction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderChangeLog" (
    "id" SERIAL NOT NULL,
    "salesOrderId" INTEGER NOT NULL,
    "lineItemId" INTEGER,
    "changeType" TEXT NOT NULL,
    "previousValue" TEXT,
    "newValue" TEXT,
    "reason" TEXT,
    "changedBy" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderChangeLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Return" (
    "id" SERIAL NOT NULL,
    "returnNumber" TEXT NOT NULL,
    "status" "ReturnStatus" NOT NULL DEFAULT 'INITIATED',
    "reason" "ReturnReason" NOT NULL,
    "reasonNotes" TEXT,
    "salesOrderId" INTEGER NOT NULL,
    "lineItemId" INTEGER,
    "customerId" INTEGER,
    "productId" INTEGER,
    "productName" TEXT,
    "partNo" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "pickupRequired" BOOLEAN NOT NULL DEFAULT false,
    "pickupAddressId" INTEGER,
    "pickupDate" TIMESTAMP(3),
    "pickupTimeSlot" TEXT,
    "pickupNotes" TEXT,
    "receivedAt" TIMESTAMP(3),
    "receivedById" INTEGER,
    "receivedLocationId" INTEGER,
    "inspectedAt" TIMESTAMP(3),
    "inspectedById" INTEGER,
    "inspectionCondition" "InspectionCondition",
    "inspectionNotes" TEXT,
    "restockedAt" TIMESTAMP(3),
    "restockedLocationId" INTEGER,
    "writeOffReason" TEXT,
    "refundPaymentId" INTEGER,
    "refundAmount" DECIMAL(65,30),
    "exchangeOrderId" INTEGER,
    "portalToken" TEXT,
    "portalRequestedAt" TIMESTAMP(3),
    "customerNotes" TEXT,
    "returnShippingMethod" TEXT,
    "returnTrackingNumber" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "Return_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Installer" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "company" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "staffMemberId" INTEGER,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "Installer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceAppointment" (
    "id" SERIAL NOT NULL,
    "appointmentNumber" TEXT NOT NULL,
    "type" "ServiceAppointmentType" NOT NULL,
    "status" "ServiceAppointmentStatus" NOT NULL DEFAULT 'PENDING',
    "salesOrderId" INTEGER NOT NULL,
    "lineItemId" INTEGER,
    "customerId" INTEGER,
    "addressId" INTEGER,
    "storeLocationId" INTEGER,
    "accessInstructions" TEXT,
    "scheduledDate" TIMESTAMP(3),
    "scheduledTime" TEXT,
    "estimatedDuration" INTEGER,
    "installerId" INTEGER,
    "designerId" INTEGER,
    "department" TEXT,
    "urgency" TEXT,
    "contactPreference" TEXT,
    "scopeOfWork" TEXT,
    "notes" TEXT,
    "completedAt" TIMESTAMP(3),
    "completionNotes" TEXT,
    "deliveryZoneId" INTEGER,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "ServiceAppointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vehicle" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "type" "VehicleType" NOT NULL DEFAULT 'BOX_TRUCK',
    "licensePlate" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "capacity" INTEGER NOT NULL DEFAULT 6,
    "notes" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryRun" (
    "id" SERIAL NOT NULL,
    "runNumber" TEXT NOT NULL,
    "runDate" TIMESTAMP(3) NOT NULL,
    "vehicleId" INTEGER NOT NULL,
    "driverId" INTEGER,
    "status" "DeliveryRunStatus" NOT NULL DEFAULT 'PLANNING',
    "departedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "notes" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "DeliveryRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryStop" (
    "id" SERIAL NOT NULL,
    "deliveryRunId" INTEGER NOT NULL,
    "serviceAppointmentId" INTEGER NOT NULL,
    "stopOrder" INTEGER NOT NULL,
    "status" "DeliveryStopStatus" NOT NULL DEFAULT 'PENDING',
    "estimatedArrival" TIMESTAMP(3),
    "actualArrival" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "signatureData" TEXT,
    "photoPath" TEXT,
    "recipientName" TEXT,
    "notes" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),

    CONSTRAINT "DeliveryStop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PickList" (
    "id" SERIAL NOT NULL,
    "pickListNumber" TEXT NOT NULL,
    "deliveryRunId" INTEGER,
    "salesOrderId" INTEGER,
    "status" "PickListStatus" NOT NULL DEFAULT 'CREATED',
    "assignedToId" INTEGER,
    "notes" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "PickList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PickListItem" (
    "id" SERIAL NOT NULL,
    "pickListId" INTEGER NOT NULL,
    "orderLineItemId" INTEGER,
    "productId" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "fromStockLocationId" INTEGER,
    "fromStoreLocationId" INTEGER,
    "toStockLocationId" INTEGER,
    "picked" BOOLEAN NOT NULL DEFAULT false,
    "pickedAt" TIMESTAMP(3),
    "pickedByUserId" TEXT,
    "notes" TEXT,

    CONSTRAINT "PickListItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsignmentReceipt" (
    "id" SERIAL NOT NULL,
    "vendorId" INTEGER NOT NULL,
    "receiptDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "manifestRef" TEXT,
    "notes" TEXT,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "ConsignmentReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsignmentItem" (
    "id" SERIAL NOT NULL,
    "vendorId" INTEGER NOT NULL,
    "productId" INTEGER,
    "barcode" TEXT NOT NULL,
    "rugNumber" TEXT,
    "customerNumber" TEXT,
    "baleNumber" TEXT,
    "quality" TEXT,
    "size" TEXT,
    "cost" DECIMAL(65,30) NOT NULL,
    "anchorPrice" DECIMAL(65,30),
    "retailPrice" DECIMAL(65,30),
    "sellingPrice" DECIMAL(65,30),
    "wasPrice" DECIMAL(65,30),
    "status" "ConsignmentItemStatus" NOT NULL DEFAULT 'ON_FLOOR',
    "year" INTEGER,
    "consignmentReceiptId" INTEGER,
    "receivedDate" TIMESTAMP(3),
    "salesOrderId" INTEGER,
    "saleDate" TIMESTAMP(3),
    "saleTransactionId" TEXT,
    "saleCustomerName" TEXT,
    "onApprovalDate" TIMESTAMP(3),
    "onApprovalCustomer" TEXT,
    "onApprovalNotes" TEXT,
    "returnedDate" TIMESTAMP(3),
    "returnReason" TEXT,
    "consignmentPaymentBatchId" INTEGER,
    "paidDate" TIMESTAMP(3),
    "creditOwed" BOOLEAN NOT NULL DEFAULT false,
    "creditBatchId" INTEGER,
    "vendorReturnId" INTEGER,
    "storeLocationId" INTEGER,
    "fmRecordId" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "ConsignmentItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsignmentPaymentBatch" (
    "id" SERIAL NOT NULL,
    "vendorId" INTEGER NOT NULL,
    "batchDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "checkNumber" TEXT,
    "totalAmount" DECIMAL(65,30) NOT NULL,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "isPaid" BOOLEAN NOT NULL DEFAULT false,
    "purchaseOrderId" INTEGER,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "ConsignmentPaymentBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsignmentSale" (
    "id" SERIAL NOT NULL,
    "transactionId" TEXT NOT NULL,
    "customerLastName" TEXT,
    "saleDate" TIMESTAMP(3),
    "totalCost" DECIMAL(65,30),
    "fmSaleId" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),

    CONSTRAINT "ConsignmentSale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsignmentSaleLine" (
    "id" SERIAL NOT NULL,
    "consignmentSaleId" INTEGER NOT NULL,
    "rugBarcode" TEXT NOT NULL,
    "cost" DECIMAL(65,30),
    "transactionId" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsignmentSaleLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsignmentVendorReturn" (
    "id" SERIAL NOT NULL,
    "vendorId" INTEGER NOT NULL,
    "status" "ConsignmentVendorReturnStatus" NOT NULL DEFAULT 'PENDING',
    "returnDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedDate" TIMESTAMP(3),
    "notes" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "ConsignmentVendorReturn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" SERIAL NOT NULL,
    "source" "LeadSource" NOT NULL,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "customerId" INTEGER,
    "email" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "phone" TEXT,
    "sourceDetail" TEXT,
    "campaignId" TEXT,
    "assignedToId" INTEGER,
    "assignedAt" TIMESTAMP(3),
    "salesOrderId" INTEGER,
    "notes" TEXT,
    "lastActionAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "archivedBy" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeTier" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "discountPercent" DECIMAL(65,30) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "TradeTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionTier" (
    "id" SERIAL NOT NULL,
    "label" TEXT NOT NULL,
    "minYtdSales" DECIMAL(65,30) NOT NULL,
    "maxYtdSalesExclusive" DECIMAL(65,30),
    "rate" DECIMAL(65,30) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "CommissionTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionPayout" (
    "id" SERIAL NOT NULL,
    "staffMemberId" INTEGER NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "periodSalesAmount" DECIMAL(65,30) NOT NULL,
    "ytdSalesAtStart" DECIMAL(65,30) NOT NULL,
    "ytdSalesAtEnd" DECIMAL(65,30) NOT NULL,
    "tierBreakdown" JSONB NOT NULL,
    "commissionAmount" DECIMAL(65,30) NOT NULL,
    "tierDefinitionSnapshot" JSONB NOT NULL,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "paidOn" TIMESTAMP(3),
    "notes" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "CommissionPayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionPayoutEdit" (
    "id" SERIAL NOT NULL,
    "payoutId" INTEGER NOT NULL,
    "fieldChanged" TEXT NOT NULL,
    "oldValue" JSONB NOT NULL,
    "newValue" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "editedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedBy" TEXT NOT NULL,

    CONSTRAINT "CommissionPayoutEdit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayPeriodConfirmation" (
    "id" SERIAL NOT NULL,
    "staffMemberId" INTEGER NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedBy" TEXT NOT NULL,
    "reopenedAt" TIMESTAMP(3),
    "reopenedBy" TEXT,
    "reopenReason" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "PayPeriodConfirmation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayPeriodIssue" (
    "id" SERIAL NOT NULL,
    "staffMemberId" INTEGER NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "note" TEXT NOT NULL,
    "reportedBy" TEXT NOT NULL,
    "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolutionNote" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "PayPeriodIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryFreeze" (
    "id" SERIAL NOT NULL,
    "freezeDate" TIMESTAMP(3) NOT NULL,
    "description" TEXT,
    "status" "InventoryFreezeStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "totalItems" INTEGER NOT NULL DEFAULT 0,
    "totalUnits" INTEGER NOT NULL DEFAULT 0,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "InventoryFreeze_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryFreezeItem" (
    "id" SERIAL NOT NULL,
    "freezeId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "storeLocationId" INTEGER,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "InventoryFreezeItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoImportLog" (
    "id" SERIAL NOT NULL,
    "runId" TEXT NOT NULL,
    "emailId" TEXT NOT NULL,
    "emailSubject" TEXT,
    "filename" TEXT NOT NULL,
    "importType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "recordCount" INTEGER NOT NULL DEFAULT 0,
    "resultSummary" JSONB,
    "errorMessage" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutoImportLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Proposal" (
    "id" SERIAL NOT NULL,
    "proposalNumber" TEXT NOT NULL,
    "status" "ProposalStatus" NOT NULL DEFAULT 'DRAFT',
    "customerId" INTEGER,
    "projectName" TEXT,
    "companyName" TEXT,
    "coverLetter" TEXT,
    "terms" TEXT,
    "internalNotes" TEXT,
    "salesPersonId" INTEGER,
    "salesOrderId" INTEGER,
    "sentAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "Proposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProposalLineItem" (
    "id" SERIAL NOT NULL,
    "proposalId" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "type" TEXT NOT NULL DEFAULT 'CUSTOM',
    "productId" INTEGER,
    "vendorStyleId" INTEGER,
    "itemName" TEXT NOT NULL,
    "itemDescription" TEXT,
    "vendorName" TEXT,
    "partNumber" TEXT,
    "cost" DECIMAL(65,30) NOT NULL,
    "retailPrice" DECIMAL(65,30) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "selectedGrade" TEXT,
    "selectedFinish" TEXT,
    "selectedOptions" TEXT,
    "itemNotes" TEXT,
    "showInOutput" BOOLEAN NOT NULL DEFAULT true,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),

    CONSTRAINT "ProposalLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProposalItemImage" (
    "id" SERIAL NOT NULL,
    "lineItemId" INTEGER NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "caption" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProposalItemImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrafficSnapshot" (
    "id" SERIAL NOT NULL,
    "intervalStart" TIMESTAMP(3) NOT NULL,
    "axperStoreName" TEXT NOT NULL,
    "storeLocationId" INTEGER,
    "visitors" INTEGER NOT NULL,
    "exits" INTEGER,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrafficSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrafficSyncLog" (
    "id" SERIAL NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "kind" TEXT NOT NULL,
    "dayFrom" TIMESTAMP(3) NOT NULL,
    "dayTo" TIMESTAMP(3) NOT NULL,
    "rowsFetched" INTEGER NOT NULL DEFAULT 0,
    "rowsInserted" INTEGER NOT NULL DEFAULT 0,
    "rowsUpdated" INTEGER NOT NULL DEFAULT 0,
    "daysScanned" INTEGER NOT NULL DEFAULT 0,
    "daysBackfilled" INTEGER NOT NULL DEFAULT 0,
    "errors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "triggeredBy" TEXT,

    CONSTRAINT "TrafficSyncLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSettings" (
    "id" SERIAL NOT NULL,
    "organizationId" INTEGER NOT NULL,
    "appName" TEXT NOT NULL DEFAULT 'Holt',
    "companyName" TEXT,
    "tagline" TEXT,
    "logoUrl" TEXT,
    "loginLogoUrl" TEXT,
    "faviconUrl" TEXT,
    "supportEmail" TEXT,
    "theme" JSONB,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "locale" TEXT NOT NULL DEFAULT 'en-US',
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "features" JSONB,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "AppSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationCredential" (
    "id" SERIAL NOT NULL,
    "organizationId" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "lastFour" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "IntegrationCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Vendor_name_key" ON "Vendor"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Vendor_code_key" ON "Vendor"("code");

-- CreateIndex
CREATE INDEX "VendorStyle_vendorId_isActive_idx" ON "VendorStyle"("vendorId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "VendorStyle_styleNumber_vendorId_key" ON "VendorStyle"("styleNumber", "vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_externalId_key" ON "Product"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Collection_vendorId_name_key" ON "Collection"("vendorId", "name");

-- CreateIndex
CREATE INDEX "PriceList_vendorId_isActive_idx" ON "PriceList"("vendorId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "PriceList_vendorId_name_key" ON "PriceList"("vendorId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "VendorPriceDimension_vendorId_name_key" ON "VendorPriceDimension"("vendorId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "PriceDimensionTier_dimensionId_code_key" ON "PriceDimensionTier"("dimensionId", "code");

-- CreateIndex
CREATE INDEX "FabricCatalog_vendorId_tierId_idx" ON "FabricCatalog"("vendorId", "tierId");

-- CreateIndex
CREATE INDEX "FabricCatalog_vendorId_fabricName_idx" ON "FabricCatalog"("vendorId", "fabricName");

-- CreateIndex
CREATE INDEX "FabricCatalog_vendorId_isActive_idx" ON "FabricCatalog"("vendorId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "FabricCatalog_vendorId_fabricName_colorName_key" ON "FabricCatalog"("vendorId", "fabricName", "colorName");

-- CreateIndex
CREATE INDEX "ProductGradePrice_productId_idx" ON "ProductGradePrice"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductGradePrice_productId_tierId_key" ON "ProductGradePrice"("productId", "tierId");

-- CreateIndex
CREATE INDEX "ProductSpeciesPrice_productId_idx" ON "ProductSpeciesPrice"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductSpeciesPrice_productId_tierId_key" ON "ProductSpeciesPrice"("productId", "tierId");

-- CreateIndex
CREATE INDEX "ProductAxisPrice_productId_idx" ON "ProductAxisPrice"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductAxisPrice_productId_tier1Id_tier2Id_tier3Id_key" ON "ProductAxisPrice"("productId", "tier1Id", "tier2Id", "tier3Id");

-- CreateIndex
CREATE INDEX "StyleGradePrice_vendorStyleId_idx" ON "StyleGradePrice"("vendorStyleId");

-- CreateIndex
CREATE UNIQUE INDEX "StyleGradePrice_vendorStyleId_tierId_key" ON "StyleGradePrice"("vendorStyleId", "tierId");

-- CreateIndex
CREATE INDEX "StyleSpeciesPrice_vendorStyleId_idx" ON "StyleSpeciesPrice"("vendorStyleId");

-- CreateIndex
CREATE UNIQUE INDEX "StyleSpeciesPrice_vendorStyleId_tierId_key" ON "StyleSpeciesPrice"("vendorStyleId", "tierId");

-- CreateIndex
CREATE INDEX "StyleAxisPrice_vendorStyleId_idx" ON "StyleAxisPrice"("vendorStyleId");

-- CreateIndex
CREATE UNIQUE INDEX "StyleAxisPrice_vendorStyleId_tier1Id_tier2Id_tier3Id_key" ON "StyleAxisPrice"("vendorStyleId", "tier1Id", "tier2Id", "tier3Id");

-- CreateIndex
CREATE UNIQUE INDEX "VendorOptionGroup_vendorId_name_key" ON "VendorOptionGroup"("vendorId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "VendorOption_groupId_name_key" ON "VendorOption"("groupId", "name");

-- CreateIndex
CREATE INDEX "ProductOptionOverride_productId_idx" ON "ProductOptionOverride"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductOptionOverride_productId_optionId_key" ON "ProductOptionOverride"("productId", "optionId");

-- CreateIndex
CREATE INDEX "StyleOptionOverride_vendorStyleId_idx" ON "StyleOptionOverride"("vendorStyleId");

-- CreateIndex
CREATE UNIQUE INDEX "StyleOptionOverride_vendorStyleId_optionId_key" ON "StyleOptionOverride"("vendorStyleId", "optionId");

-- CreateIndex
CREATE UNIQUE INDEX "VendorProgram_vendorId_name_key" ON "VendorProgram"("vendorId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Department_name_key" ON "Department"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Category_name_departmentId_key" ON "Category"("name", "departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "Type_name_categoryId_key" ON "Type"("name", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "Upc_upc_key" ON "Upc"("upc");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_email_key" ON "Customer"("email");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerExternalId_externalId_key" ON "CustomerExternalId"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "WindfallEnrichment_customerId_key" ON "WindfallEnrichment"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "WindfallEnrichment_windfallId_key" ON "WindfallEnrichment"("windfallId");

-- CreateIndex
CREATE INDEX "WindfallEnrichment_wealthTier_idx" ON "WindfallEnrichment"("wealthTier");

-- CreateIndex
CREATE INDEX "MailchimpActivity_created_idx" ON "MailchimpActivity"("created");

-- CreateIndex
CREATE UNIQUE INDEX "MailchimpActivity_email_campaignId_action_timestamp_key" ON "MailchimpActivity"("email", "campaignId", "action", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "MailchimpCampaignStats_campaignId_key" ON "MailchimpCampaignStats"("campaignId");

-- CreateIndex
CREATE INDEX "CampaignTarget_tileId_sentAt_idx" ON "CampaignTarget"("tileId", "sentAt" DESC);

-- CreateIndex
CREATE INDEX "CampaignTarget_customerId_tileId_sentAt_idx" ON "CampaignTarget"("customerId", "tileId", "sentAt" DESC);

-- CreateIndex
CREATE INDEX "ProductPairing_isActive_sortOrder_idx" ON "ProductPairing"("isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "MailchimpSyncLog_kind_created_idx" ON "MailchimpSyncLog"("kind", "created");

-- CreateIndex
CREATE INDEX "MailchimpSyncLog_status_idx" ON "MailchimpSyncLog"("status");

-- CreateIndex
CREATE UNIQUE INDEX "MonthlySalesPercentage_year_month_key" ON "MonthlySalesPercentage"("year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "SalesGoals_year_goalType_entityName_key" ON "SalesGoals"("year", "goalType", "entityName");

-- CreateIndex
CREATE INDEX "PhysicalInventoryCount_countedAt_stockLocation_userId_idx" ON "PhysicalInventoryCount"("countedAt", "stockLocation", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "InventorySnapshot_externalId_stockLocation_snapshotDate_key" ON "InventorySnapshot"("externalId", "stockLocation", "snapshotDate");

-- CreateIndex
CREATE UNIQUE INDEX "Reconciliation_productId_location_key" ON "Reconciliation"("productId", "location");

-- CreateIndex
CREATE INDEX "UnidentifiedScan_location_reconciliationStatus_idx" ON "UnidentifiedScan"("location", "reconciliationStatus");

-- CreateIndex
CREATE UNIQUE INDEX "StoreLocation_name_key" ON "StoreLocation"("name");

-- CreateIndex
CREATE UNIQUE INDEX "StoreLocation_code_key" ON "StoreLocation"("code");

-- CreateIndex
CREATE UNIQUE INDEX "StoreLocation_externalLocationName_key" ON "StoreLocation"("externalLocationName");

-- CreateIndex
CREATE UNIQUE INDEX "StockLocation_storeLocationId_code_key" ON "StockLocation"("storeLocationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryPosition_productId_storeLocationId_stockLocationId_key" ON "InventoryPosition"("productId", "storeLocationId", "stockLocationId", "salesOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryZone_name_key" ON "DeliveryZone"("name");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryZoneZip_deliveryZoneId_zipCode_key" ON "DeliveryZoneZip"("deliveryZoneId", "zipCode");

-- CreateIndex
CREATE INDEX "InventoryTransfer_fromLocation_toLocation_idx" ON "InventoryTransfer"("fromLocation", "toLocation");

-- CreateIndex
CREATE INDEX "InventoryTransfer_fromLocationId_toLocationId_idx" ON "InventoryTransfer"("fromLocationId", "toLocationId");

-- CreateIndex
CREATE INDEX "InventoryTransfer_status_idx" ON "InventoryTransfer"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_poNumber_key" ON "PurchaseOrder"("poNumber");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrderItem_externalPorNo_key" ON "PurchaseOrderItem"("externalPorNo");

-- CreateIndex
CREATE INDEX "PurchaseOrderItem_orderLineItemId_idx" ON "PurchaseOrderItem"("orderLineItemId");

-- CreateIndex
CREATE INDEX "ReceivingRecord_receivedDate_idx" ON "ReceivingRecord"("receivedDate");

-- CreateIndex
CREATE INDEX "ReceivingRecord_purchaseOrderItemId_idx" ON "ReceivingRecord"("purchaseOrderItemId");

-- CreateIndex
CREATE UNIQUE INDEX "ReceivingRecord_externalGipNo_externalPorNo_key" ON "ReceivingRecord"("externalGipNo", "externalPorNo");

-- CreateIndex
CREATE INDEX "BuyerDraftPurchaseOrder_vendorId_status_idx" ON "BuyerDraftPurchaseOrder"("vendorId", "status");

-- CreateIndex
CREATE INDEX "BuyerDraftPurchaseOrder_status_idx" ON "BuyerDraftPurchaseOrder"("status");

-- CreateIndex
CREATE INDEX "BuyerDraftPurchaseOrder_buyId_idx" ON "BuyerDraftPurchaseOrder"("buyId");

-- CreateIndex
CREATE UNIQUE INDEX "BuyerDraftPoRealPoLink_realPoId_key" ON "BuyerDraftPoRealPoLink"("realPoId");

-- CreateIndex
CREATE INDEX "BuyerDraftPoRealPoLink_draftPoId_idx" ON "BuyerDraftPoRealPoLink"("draftPoId");

-- CreateIndex
CREATE INDEX "BuyerDraftBuy_status_idx" ON "BuyerDraftBuy"("status");

-- CreateIndex
CREATE INDEX "BuyerDraftBuy_year_season_idx" ON "BuyerDraftBuy"("year", "season");

-- CreateIndex
CREATE INDEX "BuyerDraftItem_vendorId_status_idx" ON "BuyerDraftItem"("vendorId", "status");

-- CreateIndex
CREATE INDEX "BuyerDraftItem_draftPoId_idx" ON "BuyerDraftItem"("draftPoId");

-- CreateIndex
CREATE INDEX "BuyerDraftItem_partNumber_idx" ON "BuyerDraftItem"("partNumber");

-- CreateIndex
CREATE INDEX "BuyerDraftItem_barcode_idx" ON "BuyerDraftItem"("barcode");

-- CreateIndex
CREATE INDEX "BuyerDraftItem_fulfilledProductId_idx" ON "BuyerDraftItem"("fulfilledProductId");

-- CreateIndex
CREATE UNIQUE INDEX "GLAccount_code_key" ON "GLAccount"("code");

-- CreateIndex
CREATE UNIQUE INDEX "AccountGroup_name_key" ON "AccountGroup"("name");

-- CreateIndex
CREATE UNIQUE INDEX "SystemGLMapping_section_label_key" ON "SystemGLMapping"("section", "label");

-- CreateIndex
CREATE INDEX "DailyReconciliationLog_date_idx" ON "DailyReconciliationLog"("date");

-- CreateIndex
CREATE INDEX "DailyReconciliationLog_created_idx" ON "DailyReconciliationLog"("created");

-- CreateIndex
CREATE INDEX "DailyReconciliationLog_balanced_idx" ON "DailyReconciliationLog"("balanced");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_journalNumber_key" ON "JournalEntry"("journalNumber");

-- CreateIndex
CREATE INDEX "JournalEntry_journalDate_idx" ON "JournalEntry"("journalDate");

-- CreateIndex
CREATE INDEX "JournalEntry_status_idx" ON "JournalEntry"("status");

-- CreateIndex
CREATE INDEX "JournalEntryLine_journalEntryId_idx" ON "JournalEntryLine"("journalEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "TaxDistrict_shortName_key" ON "TaxDistrict"("shortName");

-- CreateIndex
CREATE INDEX "TaxDistrictZipCode_zipCode_idx" ON "TaxDistrictZipCode"("zipCode");

-- CreateIndex
CREATE UNIQUE INDEX "TaxDistrictZipCode_districtId_zipCode_key" ON "TaxDistrictZipCode"("districtId", "zipCode");

-- CreateIndex
CREATE UNIQUE INDEX "TaxExemptReason_name_key" ON "TaxExemptReason"("name");

-- CreateIndex
CREATE UNIQUE INDEX "TaxGroup_name_key" ON "TaxGroup"("name");

-- CreateIndex
CREATE UNIQUE INDEX "TaxRule_districtId_groupId_sortOrder_key" ON "TaxRule"("districtId", "groupId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrder_orderno_key" ON "SalesOrder"("orderno");

-- CreateIndex
CREATE INDEX "SalesOrder_quoteCode_idx" ON "SalesOrder"("quoteCode");

-- CreateIndex
CREATE INDEX "SalesOrder_replacedByOrderId_idx" ON "SalesOrder"("replacedByOrderId");

-- CreateIndex
CREATE INDEX "SalesOrder_status_orderDate_idx" ON "SalesOrder"("status", "orderDate");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLineItem_replacedByLineItemId_key" ON "OrderLineItem"("replacedByLineItemId");

-- CreateIndex
CREATE INDEX "OrderLineItem_productId_idx" ON "OrderLineItem"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLineItem_salesOrderId_lineNumber_key" ON "OrderLineItem"("salesOrderId", "lineNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_invoiceNo_key" ON "Invoice"("invoiceNo");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceLineItem_invoiceId_orderLineItemId_key" ON "InvoiceLineItem"("invoiceId", "orderLineItemId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_paymentCode_key" ON "Payment"("paymentCode");

-- CreateIndex
CREATE INDEX "Payment_salesOrderId_idx" ON "Payment"("salesOrderId");

-- CreateIndex
CREATE INDEX "Payment_paymentDate_idx" ON "Payment"("paymentDate");

-- CreateIndex
CREATE INDEX "Payment_tillId_idx" ON "Payment"("tillId");

-- CreateIndex
CREATE UNIQUE INDEX "NavPermission_navItem_role_key" ON "NavPermission"("navItem", "role");

-- CreateIndex
CREATE UNIQUE INDEX "StaffMember_userId_key" ON "StaffMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "StaffMember_email_key" ON "StaffMember"("email");

-- CreateIndex
CREATE INDEX "SalesGoal_fiscalYear_idx" ON "SalesGoal"("fiscalYear");

-- CreateIndex
CREATE UNIQUE INDEX "SalesGoal_staffMemberId_fiscalYear_key" ON "SalesGoal"("staffMemberId", "fiscalYear");

-- CreateIndex
CREATE INDEX "StaffShift_storeLocation_clockIn_idx" ON "StaffShift"("storeLocation", "clockIn");

-- CreateIndex
CREATE INDEX "StaffShift_staffMemberId_clockIn_idx" ON "StaffShift"("staffMemberId", "clockIn");

-- CreateIndex
CREATE INDEX "StaffShift_storeLocationId_idx" ON "StaffShift"("storeLocationId");

-- CreateIndex
CREATE INDEX "UpBoardEntry_storeLocation_status_idx" ON "UpBoardEntry"("storeLocation", "status");

-- CreateIndex
CREATE UNIQUE INDEX "UpBoardEntry_storeLocation_position_key" ON "UpBoardEntry"("storeLocation", "position");

-- CreateIndex
CREATE UNIQUE INDEX "UpBoardEntry_staffMemberId_storeLocation_key" ON "UpBoardEntry"("staffMemberId", "storeLocation");

-- CreateIndex
CREATE INDEX "SEComponent_vendorId_componentType_idx" ON "SEComponent"("vendorId", "componentType");

-- CreateIndex
CREATE UNIQUE INDEX "SEComponent_vendorId_componentType_code_key" ON "SEComponent"("vendorId", "componentType", "code");

-- CreateIndex
CREATE UNIQUE INDEX "GiftCard_barcode_key" ON "GiftCard"("barcode");

-- CreateIndex
CREATE UNIQUE INDEX "GiftCard_externalCode_key" ON "GiftCard"("externalCode");

-- CreateIndex
CREATE INDEX "GiftCard_status_idx" ON "GiftCard"("status");

-- CreateIndex
CREATE INDEX "GiftCardTransaction_giftCardId_idx" ON "GiftCardTransaction"("giftCardId");

-- CreateIndex
CREATE INDEX "GiftCardTransaction_created_idx" ON "GiftCardTransaction"("created");

-- CreateIndex
CREATE UNIQUE INDEX "GiftCardPreset_code_key" ON "GiftCardPreset"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Register_storeLocationId_name_key" ON "Register"("storeLocationId", "name");

-- CreateIndex
CREATE INDEX "Till_registerId_status_idx" ON "Till"("registerId", "status");

-- CreateIndex
CREATE INDEX "Till_openedAt_idx" ON "Till"("openedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TillCount_tillId_denomination_isOpening_key" ON "TillCount"("tillId", "denomination", "isOpening");

-- CreateIndex
CREATE INDEX "CustomerCreditTransaction_customerId_idx" ON "CustomerCreditTransaction"("customerId");

-- CreateIndex
CREATE INDEX "CustomerCreditTransaction_created_idx" ON "CustomerCreditTransaction"("created");

-- CreateIndex
CREATE INDEX "CustomerLedgerEntry_customerId_created_idx" ON "CustomerLedgerEntry"("customerId", "created");

-- CreateIndex
CREATE INDEX "CustomerLedgerEntry_created_idx" ON "CustomerLedgerEntry"("created");

-- CreateIndex
CREATE INDEX "CustomerLedgerEntry_salesOrderId_idx" ON "CustomerLedgerEntry"("salesOrderId");

-- CreateIndex
CREATE INDEX "CustomerLedgerEntry_paymentId_idx" ON "CustomerLedgerEntry"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceCaseType_name_key" ON "ServiceCaseType"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceCaseStatus_name_key" ON "ServiceCaseStatus"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceCasePriority_name_key" ON "ServiceCasePriority"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceCase_caseNumber_key" ON "ServiceCase"("caseNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceCase_externalSourceId_key" ON "ServiceCase"("externalSourceId");

-- CreateIndex
CREATE INDEX "ServiceCase_statusId_idx" ON "ServiceCase"("statusId");

-- CreateIndex
CREATE INDEX "ServiceCase_assignedToId_idx" ON "ServiceCase"("assignedToId");

-- CreateIndex
CREATE INDEX "ServiceCase_customerId_idx" ON "ServiceCase"("customerId");

-- CreateIndex
CREATE INDEX "ServiceCase_salesOrderId_idx" ON "ServiceCase"("salesOrderId");

-- CreateIndex
CREATE INDEX "ServiceCase_purchaseOrderId_idx" ON "ServiceCase"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "ServiceCase_externalSource_idx" ON "ServiceCase"("externalSource");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceCaseNote_externalSourceId_key" ON "ServiceCaseNote"("externalSourceId");

-- CreateIndex
CREATE INDEX "ServiceCaseNote_caseId_created_idx" ON "ServiceCaseNote"("caseId", "created");

-- CreateIndex
CREATE INDEX "ServiceTask_caseId_idx" ON "ServiceTask"("caseId");

-- CreateIndex
CREATE INDEX "ServiceTask_assignedToId_idx" ON "ServiceTask"("assignedToId");

-- CreateIndex
CREATE INDEX "ServiceTask_status_idx" ON "ServiceTask"("status");

-- CreateIndex
CREATE UNIQUE INDEX "EmailTemplate_name_key" ON "EmailTemplate"("name");

-- CreateIndex
CREATE INDEX "ServiceEmail_caseId_idx" ON "ServiceEmail"("caseId");

-- CreateIndex
CREATE INDEX "CustomerInteraction_staffMemberId_isActive_idx" ON "CustomerInteraction"("staffMemberId", "isActive");

-- CreateIndex
CREATE INDEX "CustomerInteraction_customerId_idx" ON "CustomerInteraction"("customerId");

-- CreateIndex
CREATE INDEX "CustomerInteraction_storeLocation_startedAt_idx" ON "CustomerInteraction"("storeLocation", "startedAt");

-- CreateIndex
CREATE INDEX "OrderChangeLog_salesOrderId_idx" ON "OrderChangeLog"("salesOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Return_returnNumber_key" ON "Return"("returnNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Return_portalToken_key" ON "Return"("portalToken");

-- CreateIndex
CREATE INDEX "Return_status_idx" ON "Return"("status");

-- CreateIndex
CREATE INDEX "Return_salesOrderId_idx" ON "Return"("salesOrderId");

-- CreateIndex
CREATE INDEX "Return_customerId_idx" ON "Return"("customerId");

-- CreateIndex
CREATE INDEX "Return_pickupDate_idx" ON "Return"("pickupDate");

-- CreateIndex
CREATE UNIQUE INDEX "Installer_staffMemberId_key" ON "Installer"("staffMemberId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceAppointment_appointmentNumber_key" ON "ServiceAppointment"("appointmentNumber");

-- CreateIndex
CREATE INDEX "ServiceAppointment_status_idx" ON "ServiceAppointment"("status");

-- CreateIndex
CREATE INDEX "ServiceAppointment_type_idx" ON "ServiceAppointment"("type");

-- CreateIndex
CREATE INDEX "ServiceAppointment_scheduledDate_idx" ON "ServiceAppointment"("scheduledDate");

-- CreateIndex
CREATE INDEX "ServiceAppointment_salesOrderId_idx" ON "ServiceAppointment"("salesOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_name_key" ON "Vehicle"("name");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryRun_runNumber_key" ON "DeliveryRun"("runNumber");

-- CreateIndex
CREATE INDEX "DeliveryRun_runDate_idx" ON "DeliveryRun"("runDate");

-- CreateIndex
CREATE INDEX "DeliveryRun_status_idx" ON "DeliveryRun"("status");

-- CreateIndex
CREATE INDEX "DeliveryRun_vehicleId_idx" ON "DeliveryRun"("vehicleId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryStop_serviceAppointmentId_key" ON "DeliveryStop"("serviceAppointmentId");

-- CreateIndex
CREATE INDEX "DeliveryStop_deliveryRunId_idx" ON "DeliveryStop"("deliveryRunId");

-- CreateIndex
CREATE UNIQUE INDEX "PickList_pickListNumber_key" ON "PickList"("pickListNumber");

-- CreateIndex
CREATE INDEX "PickList_deliveryRunId_idx" ON "PickList"("deliveryRunId");

-- CreateIndex
CREATE INDEX "PickList_salesOrderId_idx" ON "PickList"("salesOrderId");

-- CreateIndex
CREATE INDEX "PickList_status_idx" ON "PickList"("status");

-- CreateIndex
CREATE INDEX "PickListItem_pickListId_idx" ON "PickListItem"("pickListId");

-- CreateIndex
CREATE UNIQUE INDEX "ConsignmentItem_barcode_key" ON "ConsignmentItem"("barcode");

-- CreateIndex
CREATE INDEX "ConsignmentItem_vendorId_status_idx" ON "ConsignmentItem"("vendorId", "status");

-- CreateIndex
CREATE INDEX "ConsignmentItem_status_idx" ON "ConsignmentItem"("status");

-- CreateIndex
CREATE INDEX "ConsignmentItem_saleTransactionId_idx" ON "ConsignmentItem"("saleTransactionId");

-- CreateIndex
CREATE INDEX "ConsignmentItem_consignmentPaymentBatchId_idx" ON "ConsignmentItem"("consignmentPaymentBatchId");

-- CreateIndex
CREATE INDEX "ConsignmentItem_creditOwed_idx" ON "ConsignmentItem"("creditOwed");

-- CreateIndex
CREATE UNIQUE INDEX "ConsignmentPaymentBatch_purchaseOrderId_key" ON "ConsignmentPaymentBatch"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "ConsignmentPaymentBatch_vendorId_batchDate_idx" ON "ConsignmentPaymentBatch"("vendorId", "batchDate");

-- CreateIndex
CREATE UNIQUE INDEX "ConsignmentSale_transactionId_key" ON "ConsignmentSale"("transactionId");

-- CreateIndex
CREATE INDEX "ConsignmentSaleLine_rugBarcode_idx" ON "ConsignmentSaleLine"("rugBarcode");

-- CreateIndex
CREATE INDEX "ConsignmentSaleLine_consignmentSaleId_idx" ON "ConsignmentSaleLine"("consignmentSaleId");

-- CreateIndex
CREATE INDEX "ConsignmentVendorReturn_vendorId_status_idx" ON "ConsignmentVendorReturn"("vendorId", "status");

-- CreateIndex
CREATE INDEX "Lead_status_idx" ON "Lead"("status");

-- CreateIndex
CREATE INDEX "Lead_assignedToId_idx" ON "Lead"("assignedToId");

-- CreateIndex
CREATE INDEX "Lead_customerId_idx" ON "Lead"("customerId");

-- CreateIndex
CREATE INDEX "Lead_campaignId_idx" ON "Lead"("campaignId");

-- CreateIndex
CREATE INDEX "Lead_lastActionAt_idx" ON "Lead"("lastActionAt");

-- CreateIndex
CREATE UNIQUE INDEX "TradeTier_name_key" ON "TradeTier"("name");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionTier_label_key" ON "CommissionTier"("label");

-- CreateIndex
CREATE INDEX "CommissionPayout_periodEnd_idx" ON "CommissionPayout"("periodEnd");

-- CreateIndex
CREATE INDEX "CommissionPayout_lockedAt_idx" ON "CommissionPayout"("lockedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionPayout_staffMemberId_periodStart_periodEnd_key" ON "CommissionPayout"("staffMemberId", "periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "CommissionPayoutEdit_payoutId_idx" ON "CommissionPayoutEdit"("payoutId");

-- CreateIndex
CREATE INDEX "CommissionPayoutEdit_editedAt_idx" ON "CommissionPayoutEdit"("editedAt");

-- CreateIndex
CREATE INDEX "PayPeriodConfirmation_periodStart_periodEnd_idx" ON "PayPeriodConfirmation"("periodStart", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "PayPeriodConfirmation_staffMemberId_periodStart_periodEnd_key" ON "PayPeriodConfirmation"("staffMemberId", "periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "PayPeriodIssue_staffMemberId_periodStart_periodEnd_idx" ON "PayPeriodIssue"("staffMemberId", "periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "PayPeriodIssue_resolvedAt_idx" ON "PayPeriodIssue"("resolvedAt");

-- CreateIndex
CREATE INDEX "InventoryFreezeItem_freezeId_idx" ON "InventoryFreezeItem"("freezeId");

-- CreateIndex
CREATE INDEX "InventoryFreezeItem_productId_idx" ON "InventoryFreezeItem"("productId");

-- CreateIndex
CREATE INDEX "AutoImportLog_runId_idx" ON "AutoImportLog"("runId");

-- CreateIndex
CREATE INDEX "AutoImportLog_created_idx" ON "AutoImportLog"("created");

-- CreateIndex
CREATE INDEX "AutoImportLog_status_idx" ON "AutoImportLog"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Proposal_proposalNumber_key" ON "Proposal"("proposalNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Proposal_salesOrderId_key" ON "Proposal"("salesOrderId");

-- CreateIndex
CREATE INDEX "TrafficSnapshot_intervalStart_idx" ON "TrafficSnapshot"("intervalStart");

-- CreateIndex
CREATE INDEX "TrafficSnapshot_storeLocationId_intervalStart_idx" ON "TrafficSnapshot"("storeLocationId", "intervalStart");

-- CreateIndex
CREATE UNIQUE INDEX "TrafficSnapshot_intervalStart_axperStoreName_key" ON "TrafficSnapshot"("intervalStart", "axperStoreName");

-- CreateIndex
CREATE INDEX "TrafficSyncLog_startedAt_idx" ON "TrafficSyncLog"("startedAt");

-- CreateIndex
CREATE INDEX "TrafficSyncLog_kind_startedAt_idx" ON "TrafficSyncLog"("kind", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "AppSettings_organizationId_key" ON "AppSettings"("organizationId");

-- CreateIndex
CREATE INDEX "IntegrationCredential_organizationId_provider_idx" ON "IntegrationCredential"("organizationId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationCredential_organizationId_provider_field_key" ON "IntegrationCredential"("organizationId", "provider", "field");

-- AddForeignKey
ALTER TABLE "VendorContact" ADD CONSTRAINT "VendorContact_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorStyle" ADD CONSTRAINT "VendorStyle_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorStyle" ADD CONSTRAINT "VendorStyle_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorStyle" ADD CONSTRAINT "VendorStyle_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorStyle" ADD CONSTRAINT "VendorStyle_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "Type"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorStyle" ADD CONSTRAINT "VendorStyle_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "Type"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_vendorStyleId_fkey" FOREIGN KEY ("vendorStyleId") REFERENCES "VendorStyle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceList" ADD CONSTRAINT "PriceList_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorPriceDimension" ADD CONSTRAINT "VendorPriceDimension_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceDimensionTier" ADD CONSTRAINT "PriceDimensionTier_dimensionId_fkey" FOREIGN KEY ("dimensionId") REFERENCES "VendorPriceDimension"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FabricCatalog" ADD CONSTRAINT "FabricCatalog_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FabricCatalog" ADD CONSTRAINT "FabricCatalog_tierId_fkey" FOREIGN KEY ("tierId") REFERENCES "PriceDimensionTier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductGradePrice" ADD CONSTRAINT "ProductGradePrice_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductGradePrice" ADD CONSTRAINT "ProductGradePrice_tierId_fkey" FOREIGN KEY ("tierId") REFERENCES "PriceDimensionTier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductSpeciesPrice" ADD CONSTRAINT "ProductSpeciesPrice_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductSpeciesPrice" ADD CONSTRAINT "ProductSpeciesPrice_tierId_fkey" FOREIGN KEY ("tierId") REFERENCES "PriceDimensionTier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductAxisPrice" ADD CONSTRAINT "ProductAxisPrice_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductAxisPrice" ADD CONSTRAINT "ProductAxisPrice_tier1Id_fkey" FOREIGN KEY ("tier1Id") REFERENCES "PriceDimensionTier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StyleGradePrice" ADD CONSTRAINT "StyleGradePrice_vendorStyleId_fkey" FOREIGN KEY ("vendorStyleId") REFERENCES "VendorStyle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StyleGradePrice" ADD CONSTRAINT "StyleGradePrice_tierId_fkey" FOREIGN KEY ("tierId") REFERENCES "PriceDimensionTier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StyleSpeciesPrice" ADD CONSTRAINT "StyleSpeciesPrice_vendorStyleId_fkey" FOREIGN KEY ("vendorStyleId") REFERENCES "VendorStyle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StyleSpeciesPrice" ADD CONSTRAINT "StyleSpeciesPrice_tierId_fkey" FOREIGN KEY ("tierId") REFERENCES "PriceDimensionTier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StyleAxisPrice" ADD CONSTRAINT "StyleAxisPrice_vendorStyleId_fkey" FOREIGN KEY ("vendorStyleId") REFERENCES "VendorStyle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StyleAxisPrice" ADD CONSTRAINT "StyleAxisPrice_tier1Id_fkey" FOREIGN KEY ("tier1Id") REFERENCES "PriceDimensionTier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorOptionGroup" ADD CONSTRAINT "VendorOptionGroup_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorOption" ADD CONSTRAINT "VendorOption_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "VendorOptionGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductOptionOverride" ADD CONSTRAINT "ProductOptionOverride_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductOptionOverride" ADD CONSTRAINT "ProductOptionOverride_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "VendorOption"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StyleOptionOverride" ADD CONSTRAINT "StyleOptionOverride_vendorStyleId_fkey" FOREIGN KEY ("vendorStyleId") REFERENCES "VendorStyle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StyleOptionOverride" ADD CONSTRAINT "StyleOptionOverride_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "VendorOption"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorProgram" ADD CONSTRAINT "VendorProgram_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_labelTemplateId_fkey" FOREIGN KEY ("labelTemplateId") REFERENCES "LabelTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_accountGroupId_fkey" FOREIGN KEY ("accountGroupId") REFERENCES "AccountGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Type" ADD CONSTRAINT "Type_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Upc" ADD CONSTRAINT "Upc_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_taxExemptReasonId_fkey" FOREIGN KEY ("taxExemptReasonId") REFERENCES "TaxExemptReason"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_defaultTaxDistrictId_fkey" FOREIGN KEY ("defaultTaxDistrictId") REFERENCES "TaxDistrict"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_tradeTierId_fkey" FOREIGN KEY ("tradeTierId") REFERENCES "TradeTier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_primaryDesignerId_fkey" FOREIGN KEY ("primaryDesignerId") REFERENCES "StaffMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerAddress" ADD CONSTRAINT "CustomerAddress_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerExternalId" ADD CONSTRAINT "CustomerExternalId_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WindfallEnrichment" ADD CONSTRAINT "WindfallEnrichment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailchimpActivity" ADD CONSTRAINT "MailchimpActivity_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailchimpActivity" ADD CONSTRAINT "MailchimpActivity_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MailchimpCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailchimpCampaignStats" ADD CONSTRAINT "MailchimpCampaignStats_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MailchimpCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignTarget" ADD CONSTRAINT "CampaignTarget_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductPairing" ADD CONSTRAINT "ProductPairing_fromDepartmentId_fkey" FOREIGN KEY ("fromDepartmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductPairing" ADD CONSTRAINT "ProductPairing_fromCategoryId_fkey" FOREIGN KEY ("fromCategoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductPairing" ADD CONSTRAINT "ProductPairing_toDepartmentId_fkey" FOREIGN KEY ("toDepartmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductPairing" ADD CONSTRAINT "ProductPairing_toCategoryId_fkey" FOREIGN KEY ("toCategoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhysicalInventoryCount" ADD CONSTRAINT "PhysicalInventoryCount_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhysicalInventoryCount" ADD CONSTRAINT "PhysicalInventoryCount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reconciliation" ADD CONSTRAINT "Reconciliation_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reconciliation" ADD CONSTRAINT "Reconciliation_reconciledByUserId_fkey" FOREIGN KEY ("reconciledByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnidentifiedScan" ADD CONSTRAINT "UnidentifiedScan_countedByUserId_fkey" FOREIGN KEY ("countedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnidentifiedScan" ADD CONSTRAINT "UnidentifiedScan_reconciledProductId_fkey" FOREIGN KEY ("reconciledProductId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreLocation" ADD CONSTRAINT "StoreLocation_defaultReceivingStockLocationId_fkey" FOREIGN KEY ("defaultReceivingStockLocationId") REFERENCES "StockLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLocation" ADD CONSTRAINT "StockLocation_storeLocationId_fkey" FOREIGN KEY ("storeLocationId") REFERENCES "StoreLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryPosition" ADD CONSTRAINT "InventoryPosition_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryPosition" ADD CONSTRAINT "InventoryPosition_storeLocationId_fkey" FOREIGN KEY ("storeLocationId") REFERENCES "StoreLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryPosition" ADD CONSTRAINT "InventoryPosition_stockLocationId_fkey" FOREIGN KEY ("stockLocationId") REFERENCES "StockLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryPosition" ADD CONSTRAINT "InventoryPosition_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryZoneZip" ADD CONSTRAINT "DeliveryZoneZip_deliveryZoneId_fkey" FOREIGN KEY ("deliveryZoneId") REFERENCES "DeliveryZone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryTransfer" ADD CONSTRAINT "InventoryTransfer_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryTransfer" ADD CONSTRAINT "InventoryTransfer_fromLocationId_fkey" FOREIGN KEY ("fromLocationId") REFERENCES "StoreLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryTransfer" ADD CONSTRAINT "InventoryTransfer_fromStockLocationId_fkey" FOREIGN KEY ("fromStockLocationId") REFERENCES "StockLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryTransfer" ADD CONSTRAINT "InventoryTransfer_toLocationId_fkey" FOREIGN KEY ("toLocationId") REFERENCES "StoreLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryTransfer" ADD CONSTRAINT "InventoryTransfer_toStockLocationId_fkey" FOREIGN KEY ("toStockLocationId") REFERENCES "StockLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryTransfer" ADD CONSTRAINT "InventoryTransfer_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "Return"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_productVariantId_fkey" FOREIGN KEY ("productVariantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_vendorStyleId_fkey" FOREIGN KEY ("vendorStyleId") REFERENCES "VendorStyle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_orderLineItemId_fkey" FOREIGN KEY ("orderLineItemId") REFERENCES "OrderLineItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceivingRecord" ADD CONSTRAINT "ReceivingRecord_destinationLocationId_fkey" FOREIGN KEY ("destinationLocationId") REFERENCES "StoreLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceivingRecord" ADD CONSTRAINT "ReceivingRecord_destinationStockLocationId_fkey" FOREIGN KEY ("destinationStockLocationId") REFERENCES "StockLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceivingRecord" ADD CONSTRAINT "ReceivingRecord_purchaseOrderItemId_fkey" FOREIGN KEY ("purchaseOrderItemId") REFERENCES "PurchaseOrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceivingRecord" ADD CONSTRAINT "ReceivingRecord_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceivingRecord" ADD CONSTRAINT "ReceivingRecord_receiverUserId_fkey" FOREIGN KEY ("receiverUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerDraftPurchaseOrder" ADD CONSTRAINT "BuyerDraftPurchaseOrder_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerDraftPurchaseOrder" ADD CONSTRAINT "BuyerDraftPurchaseOrder_storeLocationId_fkey" FOREIGN KEY ("storeLocationId") REFERENCES "StoreLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerDraftPurchaseOrder" ADD CONSTRAINT "BuyerDraftPurchaseOrder_buyId_fkey" FOREIGN KEY ("buyId") REFERENCES "BuyerDraftBuy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerDraftPoRealPoLink" ADD CONSTRAINT "BuyerDraftPoRealPoLink_draftPoId_fkey" FOREIGN KEY ("draftPoId") REFERENCES "BuyerDraftPurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerDraftPoRealPoLink" ADD CONSTRAINT "BuyerDraftPoRealPoLink_realPoId_fkey" FOREIGN KEY ("realPoId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerDraftItem" ADD CONSTRAINT "BuyerDraftItem_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerDraftItem" ADD CONSTRAINT "BuyerDraftItem_vendorStyleId_fkey" FOREIGN KEY ("vendorStyleId") REFERENCES "VendorStyle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerDraftItem" ADD CONSTRAINT "BuyerDraftItem_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerDraftItem" ADD CONSTRAINT "BuyerDraftItem_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerDraftItem" ADD CONSTRAINT "BuyerDraftItem_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "Type"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerDraftItem" ADD CONSTRAINT "BuyerDraftItem_draftPoId_fkey" FOREIGN KEY ("draftPoId") REFERENCES "BuyerDraftPurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerDraftItem" ADD CONSTRAINT "BuyerDraftItem_stockLocationId_fkey" FOREIGN KEY ("stockLocationId") REFERENCES "StockLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerDraftItem" ADD CONSTRAINT "BuyerDraftItem_fulfilledProductId_fkey" FOREIGN KEY ("fulfilledProductId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountGroup" ADD CONSTRAINT "AccountGroup_cogsAccountId_fkey" FOREIGN KEY ("cogsAccountId") REFERENCES "GLAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountGroup" ADD CONSTRAINT "AccountGroup_inventoryAccountId_fkey" FOREIGN KEY ("inventoryAccountId") REFERENCES "GLAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountGroup" ADD CONSTRAINT "AccountGroup_salesAccountId_fkey" FOREIGN KEY ("salesAccountId") REFERENCES "GLAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountGroup" ADD CONSTRAINT "AccountGroup_returnsAccountId_fkey" FOREIGN KEY ("returnsAccountId") REFERENCES "GLAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountGroup" ADD CONSTRAINT "AccountGroup_transfersAccountId_fkey" FOREIGN KEY ("transfersAccountId") REFERENCES "GLAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountGroup" ADD CONSTRAINT "AccountGroup_shrinkageAccountId_fkey" FOREIGN KEY ("shrinkageAccountId") REFERENCES "GLAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SystemGLMapping" ADD CONSTRAINT "SystemGLMapping_glAccountId_fkey" FOREIGN KEY ("glAccountId") REFERENCES "GLAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_storeLocationId_fkey" FOREIGN KEY ("storeLocationId") REFERENCES "StoreLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntryLine" ADD CONSTRAINT "JournalEntryLine_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntryLine" ADD CONSTRAINT "JournalEntryLine_glAccountId_fkey" FOREIGN KEY ("glAccountId") REFERENCES "GLAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxDistrict" ADD CONSTRAINT "TaxDistrict_glAccountId_fkey" FOREIGN KEY ("glAccountId") REFERENCES "GLAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxDistrictZipCode" ADD CONSTRAINT "TaxDistrictZipCode_districtId_fkey" FOREIGN KEY ("districtId") REFERENCES "TaxDistrict"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxRule" ADD CONSTRAINT "TaxRule_districtId_fkey" FOREIGN KEY ("districtId") REFERENCES "TaxDistrict"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxRule" ADD CONSTRAINT "TaxRule_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "TaxGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxRule" ADD CONSTRAINT "TaxRule_ruleToAddBeforeCalcId_fkey" FOREIGN KEY ("ruleToAddBeforeCalcId") REFERENCES "TaxRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_salesPersonId_fkey" FOREIGN KEY ("salesPersonId") REFERENCES "StaffMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_splitWithId_fkey" FOREIGN KEY ("splitWithId") REFERENCES "StaffMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_storeLocationId_fkey" FOREIGN KEY ("storeLocationId") REFERENCES "StoreLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_taxDistrictId_fkey" FOREIGN KEY ("taxDistrictId") REFERENCES "TaxDistrict"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_taxExemptReasonId_fkey" FOREIGN KEY ("taxExemptReasonId") REFERENCES "TaxExemptReason"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_deliveryAddressId_fkey" FOREIGN KEY ("deliveryAddressId") REFERENCES "CustomerAddress"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_pickupLocationId_fkey" FOREIGN KEY ("pickupLocationId") REFERENCES "StoreLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_replacedByOrderId_fkey" FOREIGN KEY ("replacedByOrderId") REFERENCES "SalesOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineItem" ADD CONSTRAINT "OrderLineItem_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineItem" ADD CONSTRAINT "OrderLineItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineItem" ADD CONSTRAINT "OrderLineItem_taxDistrictId_fkey" FOREIGN KEY ("taxDistrictId") REFERENCES "TaxDistrict"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineItem" ADD CONSTRAINT "OrderLineItem_vendorStyleId_fkey" FOREIGN KEY ("vendorStyleId") REFERENCES "VendorStyle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineItem" ADD CONSTRAINT "OrderLineItem_replacedByLineItemId_fkey" FOREIGN KEY ("replacedByLineItemId") REFERENCES "OrderLineItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLineItem" ADD CONSTRAINT "InvoiceLineItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLineItem" ADD CONSTRAINT "InvoiceLineItem_orderLineItemId_fkey" FOREIGN KEY ("orderLineItemId") REFERENCES "OrderLineItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_storeLocationId_fkey" FOREIGN KEY ("storeLocationId") REFERENCES "StoreLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_registerId_fkey" FOREIGN KEY ("registerId") REFERENCES "Register"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_tillId_fkey" FOREIGN KEY ("tillId") REFERENCES "Till"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_staffMemberId_fkey" FOREIGN KEY ("staffMemberId") REFERENCES "StaffMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_giftCardId_fkey" FOREIGN KEY ("giftCardId") REFERENCES "GiftCard"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_originalPaymentId_fkey" FOREIGN KEY ("originalPaymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffMember" ADD CONSTRAINT "StaffMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffMember" ADD CONSTRAINT "StaffMember_activeStoreLocationId_fkey" FOREIGN KEY ("activeStoreLocationId") REFERENCES "StoreLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesGoal" ADD CONSTRAINT "SalesGoal_staffMemberId_fkey" FOREIGN KEY ("staffMemberId") REFERENCES "StaffMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffShift" ADD CONSTRAINT "StaffShift_staffMemberId_fkey" FOREIGN KEY ("staffMemberId") REFERENCES "StaffMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffShift" ADD CONSTRAINT "StaffShift_storeLocationId_fkey" FOREIGN KEY ("storeLocationId") REFERENCES "StoreLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpBoardEntry" ADD CONSTRAINT "UpBoardEntry_staffMemberId_fkey" FOREIGN KEY ("staffMemberId") REFERENCES "StaffMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpBoardEntry" ADD CONSTRAINT "UpBoardEntry_storeLocationId_fkey" FOREIGN KEY ("storeLocationId") REFERENCES "StoreLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SEComponent" ADD CONSTRAINT "SEComponent_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftCardTransaction" ADD CONSTRAINT "GiftCardTransaction_giftCardId_fkey" FOREIGN KEY ("giftCardId") REFERENCES "GiftCard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Register" ADD CONSTRAINT "Register_storeLocationId_fkey" FOREIGN KEY ("storeLocationId") REFERENCES "StoreLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Till" ADD CONSTRAINT "Till_registerId_fkey" FOREIGN KEY ("registerId") REFERENCES "Register"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Till" ADD CONSTRAINT "Till_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "StaffMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Till" ADD CONSTRAINT "Till_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "StaffMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TillCount" ADD CONSTRAINT "TillCount_tillId_fkey" FOREIGN KEY ("tillId") REFERENCES "Till"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCreditTransaction" ADD CONSTRAINT "CustomerCreditTransaction_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCreditTransaction" ADD CONSTRAINT "CustomerCreditTransaction_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCreditTransaction" ADD CONSTRAINT "CustomerCreditTransaction_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerLedgerEntry" ADD CONSTRAINT "CustomerLedgerEntry_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerLedgerEntry" ADD CONSTRAINT "CustomerLedgerEntry_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerLedgerEntry" ADD CONSTRAINT "CustomerLedgerEntry_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerLedgerEntry" ADD CONSTRAINT "CustomerLedgerEntry_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceCase" ADD CONSTRAINT "ServiceCase_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "ServiceCaseType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceCase" ADD CONSTRAINT "ServiceCase_statusId_fkey" FOREIGN KEY ("statusId") REFERENCES "ServiceCaseStatus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceCase" ADD CONSTRAINT "ServiceCase_priorityId_fkey" FOREIGN KEY ("priorityId") REFERENCES "ServiceCasePriority"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceCase" ADD CONSTRAINT "ServiceCase_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceCase" ADD CONSTRAINT "ServiceCase_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceCase" ADD CONSTRAINT "ServiceCase_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceCase" ADD CONSTRAINT "ServiceCase_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceCase" ADD CONSTRAINT "ServiceCase_salesPersonId_fkey" FOREIGN KEY ("salesPersonId") REFERENCES "StaffMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceCase" ADD CONSTRAINT "ServiceCase_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "StaffMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceCase" ADD CONSTRAINT "ServiceCase_storeLocationId_fkey" FOREIGN KEY ("storeLocationId") REFERENCES "StoreLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceCaseNote" ADD CONSTRAINT "ServiceCaseNote_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ServiceCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceCaseNote" ADD CONSTRAINT "ServiceCaseNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "StaffMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceTask" ADD CONSTRAINT "ServiceTask_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ServiceCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceTask" ADD CONSTRAINT "ServiceTask_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "StaffMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceTask" ADD CONSTRAINT "ServiceTask_linkedOrderId_fkey" FOREIGN KEY ("linkedOrderId") REFERENCES "SalesOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceTask" ADD CONSTRAINT "ServiceTask_linkedPurchaseOrderId_fkey" FOREIGN KEY ("linkedPurchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceEmail" ADD CONSTRAINT "ServiceEmail_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ServiceCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceEmail" ADD CONSTRAINT "ServiceEmail_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "EmailTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerInteraction" ADD CONSTRAINT "CustomerInteraction_staffMemberId_fkey" FOREIGN KEY ("staffMemberId") REFERENCES "StaffMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerInteraction" ADD CONSTRAINT "CustomerInteraction_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerInteraction" ADD CONSTRAINT "CustomerInteraction_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerInteraction" ADD CONSTRAINT "CustomerInteraction_storeLocationId_fkey" FOREIGN KEY ("storeLocationId") REFERENCES "StoreLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderChangeLog" ADD CONSTRAINT "OrderChangeLog_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Return" ADD CONSTRAINT "Return_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Return" ADD CONSTRAINT "Return_lineItemId_fkey" FOREIGN KEY ("lineItemId") REFERENCES "OrderLineItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Return" ADD CONSTRAINT "Return_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Return" ADD CONSTRAINT "Return_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Return" ADD CONSTRAINT "Return_pickupAddressId_fkey" FOREIGN KEY ("pickupAddressId") REFERENCES "CustomerAddress"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Return" ADD CONSTRAINT "Return_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "StaffMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Return" ADD CONSTRAINT "Return_receivedLocationId_fkey" FOREIGN KEY ("receivedLocationId") REFERENCES "StoreLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Return" ADD CONSTRAINT "Return_inspectedById_fkey" FOREIGN KEY ("inspectedById") REFERENCES "StaffMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Return" ADD CONSTRAINT "Return_restockedLocationId_fkey" FOREIGN KEY ("restockedLocationId") REFERENCES "StoreLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Return" ADD CONSTRAINT "Return_refundPaymentId_fkey" FOREIGN KEY ("refundPaymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Return" ADD CONSTRAINT "Return_exchangeOrderId_fkey" FOREIGN KEY ("exchangeOrderId") REFERENCES "SalesOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Installer" ADD CONSTRAINT "Installer_staffMemberId_fkey" FOREIGN KEY ("staffMemberId") REFERENCES "StaffMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceAppointment" ADD CONSTRAINT "ServiceAppointment_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceAppointment" ADD CONSTRAINT "ServiceAppointment_lineItemId_fkey" FOREIGN KEY ("lineItemId") REFERENCES "OrderLineItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceAppointment" ADD CONSTRAINT "ServiceAppointment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceAppointment" ADD CONSTRAINT "ServiceAppointment_addressId_fkey" FOREIGN KEY ("addressId") REFERENCES "CustomerAddress"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceAppointment" ADD CONSTRAINT "ServiceAppointment_storeLocationId_fkey" FOREIGN KEY ("storeLocationId") REFERENCES "StoreLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceAppointment" ADD CONSTRAINT "ServiceAppointment_installerId_fkey" FOREIGN KEY ("installerId") REFERENCES "Installer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceAppointment" ADD CONSTRAINT "ServiceAppointment_designerId_fkey" FOREIGN KEY ("designerId") REFERENCES "StaffMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceAppointment" ADD CONSTRAINT "ServiceAppointment_deliveryZoneId_fkey" FOREIGN KEY ("deliveryZoneId") REFERENCES "DeliveryZone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryRun" ADD CONSTRAINT "DeliveryRun_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryRun" ADD CONSTRAINT "DeliveryRun_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "StaffMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryStop" ADD CONSTRAINT "DeliveryStop_deliveryRunId_fkey" FOREIGN KEY ("deliveryRunId") REFERENCES "DeliveryRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryStop" ADD CONSTRAINT "DeliveryStop_serviceAppointmentId_fkey" FOREIGN KEY ("serviceAppointmentId") REFERENCES "ServiceAppointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickList" ADD CONSTRAINT "PickList_deliveryRunId_fkey" FOREIGN KEY ("deliveryRunId") REFERENCES "DeliveryRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickList" ADD CONSTRAINT "PickList_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickList" ADD CONSTRAINT "PickList_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "StaffMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickListItem" ADD CONSTRAINT "PickListItem_pickListId_fkey" FOREIGN KEY ("pickListId") REFERENCES "PickList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickListItem" ADD CONSTRAINT "PickListItem_orderLineItemId_fkey" FOREIGN KEY ("orderLineItemId") REFERENCES "OrderLineItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickListItem" ADD CONSTRAINT "PickListItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickListItem" ADD CONSTRAINT "PickListItem_fromStockLocationId_fkey" FOREIGN KEY ("fromStockLocationId") REFERENCES "StockLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickListItem" ADD CONSTRAINT "PickListItem_fromStoreLocationId_fkey" FOREIGN KEY ("fromStoreLocationId") REFERENCES "StoreLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickListItem" ADD CONSTRAINT "PickListItem_toStockLocationId_fkey" FOREIGN KEY ("toStockLocationId") REFERENCES "StockLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsignmentReceipt" ADD CONSTRAINT "ConsignmentReceipt_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsignmentItem" ADD CONSTRAINT "ConsignmentItem_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsignmentItem" ADD CONSTRAINT "ConsignmentItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsignmentItem" ADD CONSTRAINT "ConsignmentItem_consignmentReceiptId_fkey" FOREIGN KEY ("consignmentReceiptId") REFERENCES "ConsignmentReceipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsignmentItem" ADD CONSTRAINT "ConsignmentItem_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsignmentItem" ADD CONSTRAINT "ConsignmentItem_consignmentPaymentBatchId_fkey" FOREIGN KEY ("consignmentPaymentBatchId") REFERENCES "ConsignmentPaymentBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsignmentItem" ADD CONSTRAINT "ConsignmentItem_creditBatchId_fkey" FOREIGN KEY ("creditBatchId") REFERENCES "ConsignmentPaymentBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsignmentItem" ADD CONSTRAINT "ConsignmentItem_vendorReturnId_fkey" FOREIGN KEY ("vendorReturnId") REFERENCES "ConsignmentVendorReturn"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsignmentItem" ADD CONSTRAINT "ConsignmentItem_storeLocationId_fkey" FOREIGN KEY ("storeLocationId") REFERENCES "StoreLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsignmentPaymentBatch" ADD CONSTRAINT "ConsignmentPaymentBatch_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsignmentPaymentBatch" ADD CONSTRAINT "ConsignmentPaymentBatch_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsignmentSaleLine" ADD CONSTRAINT "ConsignmentSaleLine_consignmentSaleId_fkey" FOREIGN KEY ("consignmentSaleId") REFERENCES "ConsignmentSale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsignmentVendorReturn" ADD CONSTRAINT "ConsignmentVendorReturn_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "StaffMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionPayout" ADD CONSTRAINT "CommissionPayout_staffMemberId_fkey" FOREIGN KEY ("staffMemberId") REFERENCES "StaffMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionPayoutEdit" ADD CONSTRAINT "CommissionPayoutEdit_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "CommissionPayout"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayPeriodConfirmation" ADD CONSTRAINT "PayPeriodConfirmation_staffMemberId_fkey" FOREIGN KEY ("staffMemberId") REFERENCES "StaffMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayPeriodIssue" ADD CONSTRAINT "PayPeriodIssue_staffMemberId_fkey" FOREIGN KEY ("staffMemberId") REFERENCES "StaffMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryFreezeItem" ADD CONSTRAINT "InventoryFreezeItem_freezeId_fkey" FOREIGN KEY ("freezeId") REFERENCES "InventoryFreeze"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryFreezeItem" ADD CONSTRAINT "InventoryFreezeItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryFreezeItem" ADD CONSTRAINT "InventoryFreezeItem_storeLocationId_fkey" FOREIGN KEY ("storeLocationId") REFERENCES "StoreLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_salesPersonId_fkey" FOREIGN KEY ("salesPersonId") REFERENCES "StaffMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProposalLineItem" ADD CONSTRAINT "ProposalLineItem_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProposalLineItem" ADD CONSTRAINT "ProposalLineItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProposalLineItem" ADD CONSTRAINT "ProposalLineItem_vendorStyleId_fkey" FOREIGN KEY ("vendorStyleId") REFERENCES "VendorStyle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProposalItemImage" ADD CONSTRAINT "ProposalItemImage_lineItemId_fkey" FOREIGN KEY ("lineItemId") REFERENCES "ProposalLineItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrafficSnapshot" ADD CONSTRAINT "TrafficSnapshot_storeLocationId_fkey" FOREIGN KEY ("storeLocationId") REFERENCES "StoreLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppSettings" ADD CONSTRAINT "AppSettings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationCredential" ADD CONSTRAINT "IntegrationCredential_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

