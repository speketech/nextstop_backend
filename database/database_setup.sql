-- ============================================================
-- NextStop: The Modern Danfo — MySQL Schema DDL
-- ============================================================
-- Engine: InnoDB | Charset: utf8mb4 | Collation: utf8mb4_unicode_ci
-- ============================================================

CREATE DATABASE IF NOT EXISTS nextstop CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE nextstop;

-- ─────────────────────────────────────────────
-- USERS (Passengers & Drivers share base table)
-- ─────────────────────────────────────────────
CREATE TABLE users (
    id              CHAR(36)        NOT NULL DEFAULT (UUID()),
    phone           VARCHAR(15)     NOT NULL,
    email           VARCHAR(255)    NOT NULL,
    password_hash   VARCHAR(255)    NOT NULL,
    full_name       VARCHAR(120)    NOT NULL,
    avatar_url      VARCHAR(512),
    role            ENUM('PASSENGER','DRIVER','ADMIN') NOT NULL DEFAULT 'PASSENGER',

    -- Professional Profile
    job_title       VARCHAR(120),
    company         VARCHAR(120),
    industry        VARCHAR(80),
    linkedin_url    VARCHAR(512),
    bio             TEXT,

    -- Verification & Safety
    nin             VARCHAR(20),
    nin_verified    BOOLEAN         NOT NULL DEFAULT FALSE,
    is_verified     BOOLEAN         NOT NULL DEFAULT FALSE,        -- email/phone verified
    women_only_pref BOOLEAN         NOT NULL DEFAULT FALSE,

    -- Auth
    refresh_token   VARCHAR(512),
    last_login_at   DATETIME,

    -- Metadata
    is_active       BOOLEAN         NOT NULL DEFAULT TRUE,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_users_phone (phone),
    UNIQUE KEY uq_users_email (email),
    INDEX idx_users_role (role),
    INDEX idx_users_nin (nin)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────
-- DRIVERS (extends users where role = DRIVER)
-- ─────────────────────────────────────────────
CREATE TABLE drivers (
    id                  CHAR(36)    NOT NULL DEFAULT (UUID()),
    user_id             CHAR(36)    NOT NULL,

    -- Status & Availability
    status              ENUM('OFFLINE','ONLINE','ON_RIDE') NOT NULL DEFAULT 'OFFLINE',
    approval_status     ENUM('PENDING','APPROVED','SUSPENDED') NOT NULL DEFAULT 'PENDING',

    -- Location (updated via WebSocket)
    current_lat         DECIMAL(10,8),
    current_lng         DECIMAL(11,8),
    last_location_at    DATETIME,

    -- Earnings
    total_earnings      DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    payout_bank_code    VARCHAR(10),
    payout_account_no   VARCHAR(20),
    payout_account_name VARCHAR(120),

    -- Ratings
    rating              DECIMAL(3,2) NOT NULL DEFAULT 5.00,
    total_trips         INT          NOT NULL DEFAULT 0,

    created_at          DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_drivers_user (user_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_drivers_status (status),
    INDEX idx_drivers_approval (approval_status),
    -- Spatial index for geo-queries
    INDEX idx_drivers_location (current_lat, current_lng)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────
-- VEHICLES
-- ─────────────────────────────────────────────
CREATE TABLE vehicles (
    id              CHAR(36)        NOT NULL DEFAULT (UUID()),
    driver_id       CHAR(36)        NOT NULL,
    make            VARCHAR(60)     NOT NULL,
    model           VARCHAR(60)     NOT NULL,
    year            YEAR            NOT NULL,
    license_plate   VARCHAR(20)     NOT NULL,
    color           VARCHAR(40),
    seat_capacity   TINYINT         NOT NULL DEFAULT 4,
    comfort_rating  TINYINT         NOT NULL DEFAULT 3 COMMENT '1-5 self-assessment',
    is_active       BOOLEAN         NOT NULL DEFAULT TRUE,

    -- Document Verification
    license_doc_url     VARCHAR(512),
    registration_doc_url VARCHAR(512),
    insurance_doc_url   VARCHAR(512),

    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_vehicles_plate (license_plate),
    FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE CASCADE,
    INDEX idx_vehicles_driver (driver_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────
-- RIDES (the core entity)
-- ─────────────────────────────────────────────
CREATE TABLE rides (
    id                  CHAR(36)        NOT NULL DEFAULT (UUID()),
    initiator_id        CHAR(36)        NOT NULL COMMENT 'user_id of the Initiator/Passenger',
    driver_id           CHAR(36)        COMMENT 'Assigned after acceptance',
    vehicle_id          CHAR(36),

    -- Route
    pickup_address      VARCHAR(255)    NOT NULL,
    pickup_lat          DECIMAL(10,8)   NOT NULL,
    pickup_lng          DECIMAL(11,8)   NOT NULL,
    dropoff_address     VARCHAR(255)    NOT NULL,
    dropoff_lat         DECIMAL(10,8)   NOT NULL,
    dropoff_lng         DECIMAL(11,8)   NOT NULL,

    -- Ride Config
    ride_type           ENUM('SOLO','RIDESHARE') NOT NULL DEFAULT 'SOLO',
    max_joiners         TINYINT         NOT NULL DEFAULT 0,
    women_only          BOOLEAN         NOT NULL DEFAULT FALSE,

    -- Pricing
    base_fare           DECIMAL(10,2)   NOT NULL COMMENT 'Agreed fare for Initiator',
    platform_fee_pct    DECIMAL(5,4)    NOT NULL DEFAULT 0.1500 COMMENT '15%',
    driver_earnings     DECIMAL(10,2)   GENERATED ALWAYS AS (base_fare * (1 - platform_fee_pct)) STORED,

    -- State Machine
    status              ENUM(
                            'REQUESTED',
                            'NEGOTIATING',
                            'ACCEPTED',
                            'ARRIVED',
                            'IN_PROGRESS',
                            'COMPLETED',
                            'CANCELLED'
                        ) NOT NULL DEFAULT 'REQUESTED',
    cancelled_by        ENUM('INITIATOR','DRIVER','SYSTEM'),
    cancel_reason       VARCHAR(255),

    -- Timing
    scheduled_at        DATETIME,
    accepted_at         DATETIME,
    arrived_at          DATETIME,
    started_at          DATETIME,
    completed_at        DATETIME,

    -- OTP for boarding
    boarding_otp        CHAR(6),
    boarding_otp_exp    DATETIME,

    created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    FOREIGN KEY (initiator_id) REFERENCES users(id),
    FOREIGN KEY (driver_id)    REFERENCES drivers(id),
    FOREIGN KEY (vehicle_id)   REFERENCES vehicles(id),
    INDEX idx_rides_status (status),
    INDEX idx_rides_driver (driver_id),
    INDEX idx_rides_initiator (initiator_id),
    INDEX idx_rides_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────
-- RIDE_JOINERS (RIDESHARE passengers)
-- ─────────────────────────────────────────────
CREATE TABLE ride_joiners (
    id              CHAR(36)        NOT NULL DEFAULT (UUID()),
    ride_id         CHAR(36)        NOT NULL,
    user_id         CHAR(36)        NOT NULL,

    -- Status
    status          ENUM('PENDING','ACCEPTED','DECLINED','BOARDED','COMPLETED') NOT NULL DEFAULT 'PENDING',

    -- Split Fare (computed at acceptance time)
    split_fare      DECIMAL(10,2)   NOT NULL DEFAULT 0.00,

    -- Pickup for this joiner (may differ from ride pickup)
    pickup_address  VARCHAR(255),
    pickup_lat      DECIMAL(10,8),
    pickup_lng      DECIMAL(11,8),

    -- Boarding
    boarded_at      DATETIME,

    requested_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_ride_joiner (ride_id, user_id),
    FOREIGN KEY (ride_id) REFERENCES rides(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id),
    INDEX idx_joiners_ride (ride_id),
    INDEX idx_joiners_user (user_id),
    INDEX idx_joiners_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────
-- FARE NEGOTIATIONS
-- ─────────────────────────────────────────────
CREATE TABLE fare_negotiations (
    id              CHAR(36)        NOT NULL DEFAULT (UUID()),
    ride_id         CHAR(36)        NOT NULL,
    driver_id       CHAR(36)        NOT NULL,
    proposed_by     ENUM('INITIATOR','DRIVER') NOT NULL,
    proposed_fare   DECIMAL(10,2)   NOT NULL,
    status          ENUM('PENDING','ACCEPTED','REJECTED','COUNTERED') NOT NULL DEFAULT 'PENDING',
    parent_id       CHAR(36)        COMMENT 'For counter-offers, references prior offer',
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    FOREIGN KEY (ride_id)   REFERENCES rides(id) ON DELETE CASCADE,
    FOREIGN KEY (driver_id) REFERENCES drivers(id),
    INDEX idx_negotiations_ride (ride_id),
    INDEX idx_negotiations_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────
-- TRANSACTIONS (Interswitch Payment Records)
-- ─────────────────────────────────────────────
CREATE TABLE transactions (
    id                      CHAR(36)        NOT NULL DEFAULT (UUID()),
    ride_id                 CHAR(36)        NOT NULL,
    payer_id                CHAR(36)        NOT NULL COMMENT 'user_id (initiator or joiner)',
    payer_type              ENUM('INITIATOR','JOINER') NOT NULL,

    -- Interswitch Fields
    tx_ref                  VARCHAR(100)    NOT NULL COMMENT 'Our unique reference sent to Interswitch',
    interswitch_tx_ref      VARCHAR(100)    COMMENT 'Interswitchs transaction reference',
    payment_url             VARCHAR(512)    COMMENT 'Redirect URL for payment',

    -- Amounts (in kobo/smallest unit to avoid float errors)
    amount_kobo             BIGINT          NOT NULL COMMENT 'Amount in kobo (multiply naira × 100)',
    amount_naira            DECIMAL(12,2)   NOT NULL,

    -- Status
    status                  ENUM('PENDING','SUCCESS','FAILED','REVERSED') NOT NULL DEFAULT 'PENDING',
    payment_method          VARCHAR(50)     COMMENT 'card, bank_transfer, ussd, etc.',

    -- Interswitch Verification Response (stored for audit)
    isw_response_code       VARCHAR(10),
    isw_response_desc       VARCHAR(255),
    isw_raw_response        JSON            COMMENT 'Full ISW verification response — for audit',

    -- Webhook
    webhook_received_at     DATETIME,
    webhook_signature       VARCHAR(255),

    -- Escrow / Payout
    driver_settled          BOOLEAN         NOT NULL DEFAULT FALSE,
    settled_at              DATETIME,

    created_at              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_tx_ref (tx_ref),
    FOREIGN KEY (ride_id)   REFERENCES rides(id),
    FOREIGN KEY (payer_id)  REFERENCES users(id),
    INDEX idx_tx_ride (ride_id),
    INDEX idx_tx_status (status),
    INDEX idx_tx_isw_ref (interswitch_tx_ref),
    INDEX idx_tx_payer (payer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────
-- RATINGS
-- ─────────────────────────────────────────────
CREATE TABLE ratings (
    id          CHAR(36)    NOT NULL DEFAULT (UUID()),
    ride_id     CHAR(36)    NOT NULL,
    rater_id    CHAR(36)    NOT NULL,
    ratee_id    CHAR(36)    NOT NULL,
    score       TINYINT     NOT NULL COMMENT '1-5',
    comment     VARCHAR(500),
    created_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_rating_ride_rater_ratee (ride_id, rater_id, ratee_id),
    FOREIGN KEY (ride_id)   REFERENCES rides(id),
    FOREIGN KEY (rater_id)  REFERENCES users(id),
    FOREIGN KEY (ratee_id)  REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────
-- PROFESSIONAL CONNECTIONS (In-app networking)
-- ─────────────────────────────────────────────
CREATE TABLE connections (
    id              CHAR(36)    NOT NULL DEFAULT (UUID()),
    requester_id    CHAR(36)    NOT NULL,
    addressee_id    CHAR(36)    NOT NULL,
    status          ENUM('PENDING','ACCEPTED','BLOCKED') NOT NULL DEFAULT 'PENDING',
    created_at      DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_connection (requester_id, addressee_id),
    FOREIGN KEY (requester_id) REFERENCES users(id),
    FOREIGN KEY (addressee_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────
-- ROUTE CHANNELS (Community chat groups)
-- ─────────────────────────────────────────────
CREATE TABLE route_channels (
    id          CHAR(36)    NOT NULL DEFAULT (UUID()),
    name        VARCHAR(120) NOT NULL,
    route_key   VARCHAR(120) NOT NULL COMMENT 'e.g. lekki-ikeja',
    description VARCHAR(255),
    created_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_route_key (route_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────
-- WEBHOOK EVENTS LOG (idempotency + audit)
-- ─────────────────────────────────────────────
CREATE TABLE webhook_events (
    id              CHAR(36)    NOT NULL DEFAULT (UUID()),
    source          VARCHAR(50) NOT NULL DEFAULT 'INTERSWITCH',
    event_type      VARCHAR(80) NOT NULL,
    payload         JSON        NOT NULL,
    signature       VARCHAR(255),
    processed       BOOLEAN     NOT NULL DEFAULT FALSE,
    processed_at    DATETIME,
    error_message   TEXT,
    received_at     DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    INDEX idx_webhook_processed (processed),
    INDEX idx_webhook_source (source)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────
-- OTP STORE (Driver NIN & general OTPs)
-- ─────────────────────────────────────────────
CREATE TABLE otp_store (
    id          CHAR(36)    NOT NULL DEFAULT (UUID()),
    user_id     CHAR(36)    NOT NULL,
    purpose     ENUM('PHONE_VERIFY','EMAIL_VERIFY','BOARDING','NIN_KYC','PASSWORD_RESET') NOT NULL,
    code        CHAR(6)     NOT NULL,
    expires_at  DATETIME    NOT NULL,
    used        BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_otp_user_purpose (user_id, purpose),
    INDEX idx_otp_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
