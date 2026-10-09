export interface Migration {
  name: string;
  sql: string;
}

const NOW = `(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

// Append-only. Never edit a shipped migration; add a new entry instead.
export const MIGRATIONS: Migration[] = [
  {
    name: '001_core',
    sql: `
      CREATE TABLE organizations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT ${NOW}
      );

      CREATE TABLE branches (
        id INTEGER PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id),
        name TEXT NOT NULL,
        code TEXT NOT NULL UNIQUE,
        address TEXT,
        phone TEXT,
        email TEXT,
        whatsapp TEXT,
        motto TEXT,
        header_text TEXT,
        footer_text TEXT,
        logo_path TEXT,
        background_path TEXT,
        timezone TEXT NOT NULL DEFAULT 'Asia/Karachi',
        currency TEXT NOT NULL DEFAULT 'PKR',
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT ${NOW}
      );

      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        full_name TEXT NOT NULL,
        role TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        failed_logins INTEGER NOT NULL DEFAULT 0,
        locked_until TEXT,
        created_at TEXT NOT NULL DEFAULT ${NOW}
      );

      CREATE TABLE user_branches (
        user_id INTEGER NOT NULL REFERENCES users(id),
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        PRIMARY KEY (user_id, branch_id)
      );

      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT ${NOW},
        last_seen TEXT NOT NULL DEFAULT ${NOW}
      );

      CREATE TABLE sequences (
        name TEXT PRIMARY KEY,
        next_value INTEGER NOT NULL
      );

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT ${NOW}
      );

      CREATE TABLE audit_events (
        id INTEGER PRIMARY KEY,
        occurred_at TEXT NOT NULL DEFAULT ${NOW},
        actor_user_id INTEGER REFERENCES users(id),
        branch_id INTEGER REFERENCES branches(id),
        action TEXT NOT NULL,
        entity TEXT NOT NULL,
        entity_id TEXT,
        before_json TEXT,
        after_json TEXT,
        source TEXT
      );

      CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
      BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;

      CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
      BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
    `,
  },
  {
    name: '002_patients',
    sql: `
      CREATE TABLE practitioners (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        specialty TEXT,
        phone TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT ${NOW}
      );

      CREATE TABLE patients (
        id INTEGER PRIMARY KEY,
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        mrn TEXT NOT NULL UNIQUE,
        full_name TEXT NOT NULL,
        dob TEXT,
        age_years_at_registration INTEGER,
        gender TEXT NOT NULL CHECK (gender IN ('M','F','O')),
        phone TEXT,
        whatsapp TEXT,
        email TEXT,
        address TEXT,
        allergies TEXT,
        practitioner_id INTEGER REFERENCES practitioners(id),
        consent_whatsapp INTEGER NOT NULL DEFAULT 0,
        consent_email INTEGER NOT NULL DEFAULT 0,
        consent_sms INTEGER NOT NULL DEFAULT 0,
        created_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT ${NOW},
        updated_by INTEGER REFERENCES users(id),
        updated_at TEXT NOT NULL DEFAULT ${NOW}
      );
      CREATE INDEX patients_name ON patients(full_name);
      CREATE INDEX patients_phone ON patients(phone);
    `,
  },
  {
    name: '003_catalog',
    sql: `
      CREATE TABLE departments (
        id INTEGER PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        display_order INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE tests (
        id INTEGER PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        department_id INTEGER NOT NULL REFERENCES departments(id),
        specimen_type TEXT NOT NULL,
        is_panel INTEGER NOT NULL DEFAULT 0,
        base_price_paisa INTEGER NOT NULL DEFAULT 0,
        tax_rate_bp INTEGER NOT NULL DEFAULT 0,
        tat_hours INTEGER NOT NULL DEFAULT 24,
        loinc_code TEXT,
        method_note TEXT,
        display_order INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT ${NOW}
      );

      CREATE TABLE test_parameters (
        id INTEGER PRIMARY KEY,
        test_id INTEGER NOT NULL REFERENCES tests(id),
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        unit TEXT,
        decimals INTEGER NOT NULL DEFAULT 1,
        result_type TEXT NOT NULL CHECK (result_type IN ('numeric','text','qualitative','calculated')),
        formula TEXT,
        qualitative_options TEXT,
        critical_low REAL,
        critical_high REAL,
        display_order INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        UNIQUE (test_id, code)
      );

      CREATE TABLE panel_members (
        panel_test_id INTEGER NOT NULL REFERENCES tests(id),
        member_test_id INTEGER NOT NULL REFERENCES tests(id),
        PRIMARY KEY (panel_test_id, member_test_id)
      );

      CREATE TABLE reference_ranges (
        id INTEGER PRIMARY KEY,
        parameter_id INTEGER NOT NULL REFERENCES test_parameters(id),
        sex TEXT NOT NULL DEFAULT 'A' CHECK (sex IN ('A','M','F')),
        age_min_days INTEGER NOT NULL DEFAULT 0,
        age_max_days INTEGER NOT NULL DEFAULT 36500,
        low REAL,
        high REAL,
        text_range TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','retired')),
        version INTEGER NOT NULL DEFAULT 1,
        note TEXT,
        created_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT ${NOW},
        approved_by INTEGER REFERENCES users(id),
        approved_at TEXT
      );

      CREATE TABLE branch_prices (
        id INTEGER PRIMARY KEY,
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        test_id INTEGER NOT NULL REFERENCES tests(id),
        price_paisa INTEGER NOT NULL,
        effective_from TEXT NOT NULL,
        created_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT ${NOW}
      );
    `,
  },
  {
    name: '004_orders',
    sql: `
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY,
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        order_no TEXT NOT NULL UNIQUE,
        patient_id INTEGER NOT NULL REFERENCES patients(id),
        practitioner_id INTEGER REFERENCES practitioners(id),
        priority TEXT NOT NULL DEFAULT 'routine' CHECK (priority IN ('routine','urgent','stat')),
        status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','in_progress','completed','cancelled')),
        created_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT ${NOW}
      );

      CREATE TABLE specimens (
        id INTEGER PRIMARY KEY,
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        order_id INTEGER NOT NULL REFERENCES orders(id),
        accession_no TEXT NOT NULL UNIQUE,
        specimen_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'expected' CHECK (status IN ('expected','collected','received','rejected','processing','stored','disposed')),
        collector_name TEXT,
        collected_at TEXT,
        collected_by INTEGER REFERENCES users(id),
        received_at TEXT,
        received_by INTEGER REFERENCES users(id),
        reject_reason TEXT,
        recollect_required INTEGER NOT NULL DEFAULT 0,
        stored_at TEXT,
        created_at TEXT NOT NULL DEFAULT ${NOW}
      );

      CREATE TABLE order_items (
        id INTEGER PRIMARY KEY,
        order_id INTEGER NOT NULL REFERENCES orders(id),
        test_id INTEGER NOT NULL REFERENCES tests(id),
        specimen_id INTEGER NOT NULL REFERENCES specimens(id),
        status TEXT NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered','collected','received','processing','completed','cancelled')),
        reagents_consumed INTEGER NOT NULL DEFAULT 0,
        tat_due_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL DEFAULT ${NOW}
      );
      CREATE INDEX order_items_status ON order_items(status);
    `,
  },
  {
    name: '005_results_reports',
    sql: `
      CREATE TABLE results (
        id INTEGER PRIMARY KEY,
        order_item_id INTEGER NOT NULL REFERENCES order_items(id),
        parameter_id INTEGER NOT NULL REFERENCES test_parameters(id),
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        value_numeric REAL,
        value_text TEXT,
        flag TEXT,
        ref_low REAL,
        ref_high REAL,
        ref_text TEXT,
        unit TEXT,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','reviewed','authorized','cancelled')),
        version INTEGER NOT NULL DEFAULT 1,
        critical INTEGER NOT NULL DEFAULT 0,
        critical_notified_to TEXT,
        critical_notified_at TEXT,
        comment TEXT,
        entered_by INTEGER REFERENCES users(id),
        entered_at TEXT,
        reviewed_by INTEGER REFERENCES users(id),
        reviewed_at TEXT,
        authorized_by INTEGER REFERENCES users(id),
        authorized_at TEXT,
        cancel_reason TEXT,
        UNIQUE (order_item_id, parameter_id)
      );

      CREATE TABLE result_revisions (
        id INTEGER PRIMARY KEY,
        result_id INTEGER NOT NULL REFERENCES results(id),
        version INTEGER NOT NULL,
        value_numeric REAL,
        value_text TEXT,
        flag TEXT,
        status TEXT NOT NULL,
        changed_by INTEGER REFERENCES users(id),
        changed_at TEXT NOT NULL DEFAULT ${NOW},
        reason TEXT
      );

      CREATE TRIGGER result_revisions_no_update BEFORE UPDATE ON result_revisions
      BEGIN SELECT RAISE(ABORT, 'result_revisions is append-only'); END;

      CREATE TRIGGER result_revisions_no_delete BEFORE DELETE ON result_revisions
      BEGIN SELECT RAISE(ABORT, 'result_revisions is append-only'); END;

      CREATE TABLE attachments (
        id INTEGER PRIMARY KEY,
        order_item_id INTEGER NOT NULL REFERENCES order_items(id),
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        filename TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        path TEXT NOT NULL,
        uploaded_by INTEGER REFERENCES users(id),
        uploaded_at TEXT NOT NULL DEFAULT ${NOW}
      );

      CREATE TABLE reports (
        id INTEGER PRIMARY KEY,
        order_id INTEGER NOT NULL REFERENCES orders(id),
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        report_no TEXT NOT NULL UNIQUE,
        verification_code TEXT NOT NULL UNIQUE,
        version INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'final' CHECK (status IN ('final','superseded')),
        pdf_path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        reason TEXT,
        issued_by INTEGER REFERENCES users(id),
        issued_at TEXT NOT NULL DEFAULT ${NOW},
        UNIQUE (order_id, version)
      );
    `,
  },
  {
    name: '006_billing',
    sql: `
      CREATE TABLE invoices (
        id INTEGER PRIMARY KEY,
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        invoice_no TEXT NOT NULL UNIQUE,
        order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
        patient_id INTEGER NOT NULL REFERENCES patients(id),
        subtotal_paisa INTEGER NOT NULL,
        discount_type TEXT NOT NULL DEFAULT 'none' CHECK (discount_type IN ('none','percent','fixed')),
        discount_value INTEGER NOT NULL DEFAULT 0,
        discount_paisa INTEGER NOT NULL DEFAULT 0,
        discount_reason TEXT,
        discount_approved_by INTEGER REFERENCES users(id),
        tax_paisa INTEGER NOT NULL DEFAULT 0,
        total_paisa INTEGER NOT NULL,
        paid_paisa INTEGER NOT NULL DEFAULT 0,
        refunded_paisa INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','partially_paid','paid','void')),
        created_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT ${NOW},
        voided_by INTEGER REFERENCES users(id),
        voided_at TEXT,
        void_reason TEXT,
        void_approved_by INTEGER REFERENCES users(id)
      );

      CREATE TABLE invoice_lines (
        id INTEGER PRIMARY KEY,
        invoice_id INTEGER NOT NULL REFERENCES invoices(id),
        test_id INTEGER NOT NULL REFERENCES tests(id),
        description TEXT NOT NULL,
        unit_price_paisa INTEGER NOT NULL,
        tax_rate_bp INTEGER NOT NULL DEFAULT 0,
        tax_paisa INTEGER NOT NULL DEFAULT 0,
        line_total_paisa INTEGER NOT NULL
      );

      CREATE TABLE payments (
        id INTEGER PRIMARY KEY,
        invoice_id INTEGER NOT NULL REFERENCES invoices(id),
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        kind TEXT NOT NULL CHECK (kind IN ('payment','refund')),
        method TEXT NOT NULL CHECK (method IN ('cash','card','bank_transfer','jazzcash','easypaisa')),
        amount_paisa INTEGER NOT NULL CHECK (amount_paisa > 0),
        reference TEXT,
        reason TEXT,
        received_by INTEGER REFERENCES users(id),
        approved_by INTEGER REFERENCES users(id),
        business_date TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT ${NOW}
      );

      CREATE TRIGGER payments_no_update BEFORE UPDATE ON payments
      BEGIN SELECT RAISE(ABORT, 'payments is append-only'); END;

      CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments
      BEGIN SELECT RAISE(ABORT, 'payments is append-only'); END;

      CREATE TABLE cash_closings (
        id INTEGER PRIMARY KEY,
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        business_date TEXT NOT NULL,
        expected_paisa INTEGER NOT NULL,
        counted_paisa INTEGER NOT NULL,
        variance_paisa INTEGER NOT NULL,
        closed_by INTEGER REFERENCES users(id),
        closed_at TEXT NOT NULL DEFAULT ${NOW},
        UNIQUE (branch_id, business_date)
      );
    `,
  },
  {
    name: '007_inventory',
    sql: `
      CREATE TABLE inv_categories (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE
      );

      CREATE TABLE inv_suppliers (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        contact TEXT
      );

      CREATE TABLE inv_locations (
        id INTEGER PRIMARY KEY,
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        name TEXT NOT NULL,
        UNIQUE (branch_id, name)
      );

      CREATE TABLE inv_items (
        id INTEGER PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        category_id INTEGER REFERENCES inv_categories(id),
        unit TEXT NOT NULL DEFAULT 'pcs',
        reorder_level REAL NOT NULL DEFAULT 0,
        near_expiry_days INTEGER NOT NULL DEFAULT 60,
        is_active INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE inv_lots (
        id INTEGER PRIMARY KEY,
        item_id INTEGER NOT NULL REFERENCES inv_items(id),
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        lot_no TEXT NOT NULL,
        expiry_date TEXT NOT NULL,
        supplier_id INTEGER REFERENCES inv_suppliers(id),
        location_id INTEGER REFERENCES inv_locations(id),
        received_at TEXT NOT NULL DEFAULT ${NOW},
        UNIQUE (item_id, branch_id, lot_no)
      );

      CREATE TABLE inv_ledger (
        id INTEGER PRIMARY KEY,
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        item_id INTEGER NOT NULL REFERENCES inv_items(id),
        lot_id INTEGER NOT NULL REFERENCES inv_lots(id),
        txn_type TEXT NOT NULL CHECK (txn_type IN ('receipt','issue','reagent_use','adjustment','wastage','return','transfer_in','transfer_out')),
        qty REAL NOT NULL,
        reason TEXT,
        reference TEXT,
        approved_by INTEGER REFERENCES users(id),
        created_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT ${NOW}
      );

      CREATE TRIGGER inv_ledger_no_update BEFORE UPDATE ON inv_ledger
      BEGIN SELECT RAISE(ABORT, 'inv_ledger is immutable'); END;

      CREATE TRIGGER inv_ledger_no_delete BEFORE DELETE ON inv_ledger
      BEGIN SELECT RAISE(ABORT, 'inv_ledger is immutable'); END;

      CREATE TABLE test_reagents (
        test_id INTEGER NOT NULL REFERENCES tests(id),
        item_id INTEGER NOT NULL REFERENCES inv_items(id),
        qty_per_test REAL NOT NULL,
        PRIMARY KEY (test_id, item_id)
      );
    `,
  },
  {
    name: '008_notifications',
    sql: `
      CREATE TABLE outbox (
        id INTEGER PRIMARY KEY,
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        patient_id INTEGER NOT NULL REFERENCES patients(id),
        report_id INTEGER REFERENCES reports(id),
        channel TEXT NOT NULL CHECK (channel IN ('email','sms','whatsapp')),
        destination TEXT NOT NULL,
        subject TEXT,
        body TEXT NOT NULL,
        attachment_path TEXT,
        status TEXT NOT NULL CHECK (status IN ('queued','retrying','sent','delivered','failed','awaiting_staff','sent_manual','cancelled')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        provider_message_id TEXT,
        last_error TEXT,
        created_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT ${NOW},
        updated_at TEXT NOT NULL DEFAULT ${NOW},
        sent_at TEXT,
        confirmed_by INTEGER REFERENCES users(id)
      );
      CREATE INDEX outbox_status ON outbox(status, next_attempt_at);
    `,
  },
  {
    name: '009_ops',
    sql: `
      CREATE TABLE backups (
        id INTEGER PRIMARY KEY,
        file TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('auto','manual')),
        created_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT ${NOW}
      );
    `,
  },
  {
    name: '010_document_design',
    sql: `
      ALTER TABLE branches ADD COLUMN brand_primary TEXT NOT NULL DEFAULT '#1F5FAE';
      ALTER TABLE branches ADD COLUMN brand_secondary TEXT NOT NULL DEFAULT '#C8102E';
      ALTER TABLE branches ADD COLUMN timings TEXT;
      ALTER TABLE branches ADD COLUMN disclaimer TEXT;
      ALTER TABLE branches ADD COLUMN incharge_name TEXT;
      ALTER TABLE branches ADD COLUMN incharge_title TEXT;
      ALTER TABLE branches ADD COLUMN incharge_signature_path TEXT;
      ALTER TABLE branches ADD COLUMN letterhead_mode INTEGER NOT NULL DEFAULT 0 CHECK (letterhead_mode IN (0,1));
      ALTER TABLE branches ADD COLUMN letterhead_top_mm INTEGER NOT NULL DEFAULT 45;
      ALTER TABLE branches ADD COLUMN letterhead_bottom_mm INTEGER NOT NULL DEFAULT 30;
      ALTER TABLE branches ADD COLUMN payment_details TEXT;
      ALTER TABLE users ADD COLUMN qualifications TEXT;
      ALTER TABLE users ADD COLUMN signature_path TEXT;
      ALTER TABLE reports ADD COLUMN print_pdf_path TEXT;
      ALTER TABLE invoices ADD COLUMN verification_code TEXT;
      UPDATE invoices SET verification_code = upper(hex(randomblob(6))) WHERE verification_code IS NULL;
      CREATE UNIQUE INDEX invoices_verification ON invoices(verification_code);
    `,
  },
];
