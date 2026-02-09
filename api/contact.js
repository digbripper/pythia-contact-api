/**
 * Vercel Serverless Function for Adding Contacts to Pythia Database
 * Endpoint: /api/contact
 */

import { Pool } from '@neondatabase/serverless';

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const contactData = req.body;
    
    // Validate required fields
    if (!contactData.first_name || !contactData.last_name) {
      return res.status(400).json({ error: 'First name and last name are required' });
    }

    // Connect to PostgreSQL
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const client = await pool.connect();

    try {
      // Start a transaction
      await client.query('BEGIN');

      // Step 1: Handle Organization (if provided)
      let organizationId = null;
      if (contactData.company && contactData.company.trim() !== '') {
        organizationId = await getOrCreateOrganization(client, contactData.company);
      }

      // Step 2: Create the Person
      const personId = await createPerson(client, contactData);

      // Step 3: Link Person to Organization (if organization exists)
      if (organizationId) {
        await linkPersonToOrganization(client, personId, organizationId, contactData);
        
        // Step 4: Link Organization to Issues (if issue_areas provided)
        if (contactData.issue_areas) {
          await linkOrganizationToIssues(client, organizationId, contactData.issue_areas);
        }
      }

      // Commit the transaction
      await client.query('COMMIT');

      return res.status(200).json({
        success: true,
        person_id: personId,
        organization_id: organizationId,
        message: `Successfully added ${contactData.first_name} ${contactData.last_name}`,
      });

    } catch (error) {
      // Rollback on error
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

  } catch (error) {
    console.error('Error processing contact:', error);
    
    // Provide more helpful error messages
    let errorMessage = 'Failed to add contact';
    let errorDetails = error.message;
    
    // Check for common database errors
    if (error.message.includes('value too long')) {
      errorMessage = 'One of the fields is too long';
      errorDetails = 'Please check that phone numbers, names, and other fields are not excessively long. Phone numbers should be under 50 characters.';
    } else if (error.message.includes('duplicate key')) {
      errorMessage = 'This person may already exist in the database';
      errorDetails = error.message;
    } else if (error.message.includes('not-null')) {
      errorMessage = 'Missing required information';
      errorDetails = 'First name and last name are required.';
    }
    
    return res.status(500).json({
      error: errorMessage,
      details: errorDetails,
      debug_info: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Safely truncate string fields to database column limits
 */
function truncateField(value, maxLength) {
  if (!value) return '';
  const str = String(value).trim();
  return str.length > maxLength ? str.substring(0, maxLength) : str;
}

/**
 * Get existing issue or create a new one
 */
async function getOrCreateIssue(client, issueName) {
  const trimmedName = issueName.trim();
  
  // Check if issue already exists (case-insensitive)
  const checkQuery = `
    SELECT id FROM organizations_issue 
    WHERE LOWER(name) = LOWER($1)
    LIMIT 1
  `;
  
  const existing = await client.query(checkQuery, [trimmedName]);
  
  if (existing.rows.length > 0) {
    return existing.rows[0].id;
  }
  
  // Create new issue
  const insertQuery = `
    INSERT INTO organizations_issue (
      id, created_at, updated_at, name, category, description, external_id
    ) VALUES (
      gen_random_uuid(), NOW(), NOW(), $1, 'General', '', NULL
    ) RETURNING id
  `;
  
  const result = await client.query(insertQuery, [trimmedName]);
  return result.rows[0].id;
}

/**
 * Link organization to issues
 */
async function linkOrganizationToIssues(client, organizationId, issueAreas) {
  if (!issueAreas || issueAreas.trim() === '') {
    return; // No issues to link
  }
  
  // Split by comma, semicolon, or newline and clean up
  const issueNames = issueAreas
    .split(/[,;\n]/)
    .map(name => name.trim())
    .filter(name => name.length > 0);
  
  // For each issue name, get/create the issue and link it
  for (const issueName of issueNames) {
    const issueId = await getOrCreateIssue(client, issueName);
    
    // Check if link already exists
    const checkLinkQuery = `
      SELECT id FROM organizations_organizationissue
      WHERE organization_id = $1 AND issue_id = $2
      LIMIT 1
    `;
    
    const existingLink = await client.query(checkLinkQuery, [organizationId, issueId]);
    
    if (existingLink.rows.length === 0) {
      // Create the link
      const insertLinkQuery = `
        INSERT INTO organizations_organizationissue (
          id, created_at, updated_at, organization_id, issue_id, priority, notes
        ) VALUES (
          gen_random_uuid(), NOW(), NOW(), $1, $2, 0, ''
        )
      `;
      
      await client.query(insertLinkQuery, [organizationId, issueId]);
    }
  }
}

/**
 * Normalize organization names to prevent duplicates
 * Handles common abbreviations and variations
 */
function normalizeOrgName(name) {
  let normalized = name.trim();
  
  // Convert to lowercase for comparison
  normalized = normalized.toLowerCase();
  
  // Expand common state abbreviations
  const stateAbbreviations = {
    'ny': 'new york',
    'nys': 'new york state',
    'ca': 'california',
    'tx': 'texas',
    'fl': 'florida',
    'il': 'illinois',
    'pa': 'pennsylvania',
    'oh': 'ohio',
    'ga': 'georgia',
    'nc': 'north carolina',
    'mi': 'michigan',
    'nj': 'new jersey',
    'va': 'virginia',
    'wa': 'washington',
    'az': 'arizona',
    'ma': 'massachusetts',
    'tn': 'tennessee',
    'in': 'indiana',
    'mo': 'missouri',
    'md': 'maryland',
    'wi': 'wisconsin',
    'co': 'colorado',
    'mn': 'minnesota',
    'sc': 'south carolina',
    'al': 'alabama',
    'la': 'louisiana',
    'ky': 'kentucky',
    'or': 'oregon',
    'ok': 'oklahoma',
    'ct': 'connecticut',
    'ut': 'utah',
    'ia': 'iowa',
    'nv': 'nevada',
    'ar': 'arkansas',
    'ms': 'mississippi',
    'ks': 'kansas',
    'nm': 'new mexico',
    'ne': 'nebraska',
    'wv': 'west virginia',
    'id': 'idaho',
    'hi': 'hawaii',
    'nh': 'new hampshire',
    'me': 'maine',
    'ri': 'rhode island',
    'mt': 'montana',
    'de': 'delaware',
    'sd': 'south dakota',
    'nd': 'north dakota',
    'ak': 'alaska',
    'vt': 'vermont',
    'wy': 'wyoming',
    'dc': 'district of columbia'
  };
  
  // Replace state abbreviations (word boundaries to avoid false matches)
  Object.entries(stateAbbreviations).forEach(([abbr, full]) => {
    const regex = new RegExp(`\\b${abbr}\\b`, 'gi');
    normalized = normalized.replace(regex, full);
  });
  
  // Remove common corporate suffixes
  const suffixes = [
    'inc\\.?',
    'incorporated',
    'llc',
    'l\\.l\\.c\\.?',
    'corp\\.?',
    'corporation',
    'ltd\\.?',
    'limited',
    'co\\.?',
    'company',
    'pllc',
    'p\\.l\\.l\\.c\\.?'
  ];
  
  suffixes.forEach(suffix => {
    const regex = new RegExp(`\\b${suffix}\\b`, 'gi');
    normalized = normalized.replace(regex, '');
  });
  
  // Normalize common words
  normalized = normalized
    .replace(/\bstate\s+senate\b/gi, 'senate')
    .replace(/\bstate\s+assembly\b/gi, 'assembly')
    .replace(/\bdept\b/gi, 'department')
    .replace(/\bdiv\b/gi, 'division')
    .replace(/\bgovt\b/gi, 'government')
    .replace(/\buniv\b/gi, 'university')
    .replace(/\bctr\b/gi, 'center')
    .replace(/\bassoc\b/gi, 'association')
    .replace(/\bintl\b/gi, 'international');
  
  // Remove extra spaces and punctuation
  normalized = normalized
    .replace(/[&]/g, 'and')
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  
  return normalized;
}

/**
 * Get existing organization or create a new one
 */
async function getOrCreateOrganization(client, companyName) {
  const trimmedName = companyName.trim();
  const normalizedName = normalizeOrgName(trimmedName);
  
  // Check if organization already exists using normalized name
  const checkQuery = `
    SELECT id, name FROM organizations_organization 
    WHERE LOWER(name) = LOWER($1) OR LOWER(name) = LOWER($2)
    LIMIT 1
  `;
  
  const existing = await client.query(checkQuery, [trimmedName, normalizedName]);
  
  if (existing.rows.length > 0) {
    return existing.rows[0].id;
  }
  
  // Also check with normalized version stored previously
  const normalizedCheck = `
    SELECT id, name FROM organizations_organization 
    WHERE LOWER(REGEXP_REPLACE(REGEXP_REPLACE(LOWER(name), '[^a-z0-9\\s]', '', 'g'), '\\s+', ' ', 'g')) = $1
    LIMIT 1
  `;
  
  const normalizedExisting = await client.query(normalizedCheck, [normalizedName]);
  
  if (normalizedExisting.rows.length > 0) {
    return normalizedExisting.rows[0].id;
  }
  
  // Create new organization with the ORIGINAL name (for display)
  // but we've checked for duplicates using the normalized name
  const insertQuery = `
    INSERT INTO organizations_organization (
      id, created_at, updated_at, name, legal_name, description, 
      email, phone, website, address_line_1, address_line_2, 
      city, state_province, postal_code, country, industry, 
      size, is_active, notes, actions, location, is_client
    ) VALUES (
      gen_random_uuid(), NOW(), NOW(), $1, '', '', 
      '', '', '', '', '', 
      '', '', '', '', '', 
      '', true, '', '', '', false
    ) RETURNING id
  `;
  
  const result = await client.query(insertQuery, [trimmedName]);
  return result.rows[0].id;
}

/**
 * Create a new person
 */
async function createPerson(client, data) {
  const insertQuery = `
    INSERT INTO people_person (
      id, created_at, updated_at, first_name, last_name, middle_name,
      title, email, phone, mobile_phone, linkedin_url, twitter_handle,
      personal_address_line_1, personal_address_line_2, personal_city,
      personal_state_province, personal_postal_code, personal_country,
      notes, is_active, full_name, date_of_birth
    ) VALUES (
      gen_random_uuid(), NOW(), NOW(), $1, $2, '',
      '', $3, $4, $5, '', '',
      '', '', '',
      '', '', '',
      $6, true, $7, NULL
    ) RETURNING id
  `;
  
  // Truncate fields to their database limits
  const firstName = truncateField(data.first_name, 150);
  const lastName = truncateField(data.last_name, 150);
  const email = truncateField(data.email, 254);
  const phone = truncateField(data.phone, 50);
  const mobilePhone = truncateField(data.mobile_phone || data.phone, 50);
  const notes = data.notes || '';
  const fullName = truncateField(`${firstName} ${lastName}`, 255);
  
  const result = await client.query(insertQuery, [
    firstName,
    lastName,
    email,
    phone,
    mobilePhone,
    notes,
    fullName,
  ]);
  
  return result.rows[0].id;
}

/**
 * Link person to organization
 */
async function linkPersonToOrganization(client, personId, organizationId, data) {
  const insertQuery = `
    INSERT INTO people_personorganization (
      id, created_at, updated_at, person_id, organization_id,
      job_title, department, is_primary, is_current,
      work_email, work_phone, work_phone_extension, notes,
      is_primary_contact, handles_areas, direct_dial,
      assistant_name, assistant_email, assistant_phone
    ) VALUES (
      gen_random_uuid(), NOW(), NOW(), $1, $2,
      $3, '', true, true,
      '', '', '', $4,
      false, ARRAY[]::text[], '',
      '', '', ''
    )
  `;
  
  // Truncate fields to their database limits
  const jobTitle = truncateField(data.job_title || data.role, 200);
  const notes = data.notes || '';
  
  await client.query(insertQuery, [
    personId,
    organizationId,
    jobTitle,
    notes,
  ]);
}
