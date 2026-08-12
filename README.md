# Simple Image Links

Dynamic image links platform designed to generate Open Graph image previews for Facebook/social media while executing fast server-side visitor redirects with country analytics.

## Zero-Folder Architecture

This project strictly enforces a **Zero-Folder Flat-File Architecture**. All project source files reside directly in the root directory.

## Vercel Deployment Setup

### 1. Database Provisioning
Create a Serverless PostgreSQL database using **Vercel Postgres**, **Supabase**, **Neon**, or **ElephantSQL**.
Execute the SQL DDL statements found in `schema.sql` on your PostgreSQL database.

### 2. Image Storage Provisioning
Create a **Vercel Blob** store in your Vercel Dashboard project.
Copy the generated `BLOB_READ_WRITE_TOKEN`.

### 3. Vercel Environment Variables
Add the following environment variables in your Vercel Project Settings:

- `DATABASE_URL`: `postgresql://user:password@host:5432/dbname?sslmode=require`
- `BLOB_READ_WRITE_TOKEN`: `vercel_blob_rw_...`
- `AUTH_SECRET`: `your-random-secret-key`
- `GEOLOCATION_API_KEY`: *(Optional)* `ipgeolocation.io API key if headers are missing`

### 4. Deploy via GitHub
Push this repository to GitHub and import it directly into Vercel.
