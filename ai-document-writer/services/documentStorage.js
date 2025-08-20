// backend/services/documentStorage.js
const fs = require('fs').promises;
const path = require('path');
const mysql = require('mysql2/promise');
const { dbConfig } = require('../middleware/auth');
const crypto = require('crypto');

class DocumentStorageService {
  constructor() {
    this.baseStoragePath = path.join(__dirname, '..', 'stored');
    this.ensureStorageDirectories();
  }

  async ensureStorageDirectories() {
    try {
      await fs.mkdir(this.baseStoragePath, { recursive: true });
    } catch (error) {
      console.error('Error creating storage directories:', error);
    }
  }

  // Generate user-specific storage path
  getUserStoragePath(userEmail) {
    const sanitizedEmail = userEmail.replace(/[^a-zA-Z0-9@.-]/g, '_');
    return path.join(this.baseStoragePath, sanitizedEmail);
  }

  // Generate document file path
  async generateDocumentPath(userEmail, templateType, title, format = 'docx') {
    const userPath = this.getUserStoragePath(userEmail);
    const documentsPath = path.join(userPath, 'documents');
    
    // Create directory structure by year/month
    const now = new Date();
    const year = now.getFullYear().toString();
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const datePath = path.join(documentsPath, year, month);
    
    await fs.mkdir(datePath, { recursive: true });
    
    // Generate safe filename
    const safeTitle = title.replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '_');
    const timestamp = Date.now();
    const filename = `${timestamp}_${templateType}_${safeTitle}.${format}`;
    
    return path.join(datePath, filename);
  }

  // Save document to storage
  async saveDocument(userEmail, documentData, fileBuffer) {
    const connection = await mysql.createConnection(dbConfig);
    
    try {
      const documentId = crypto.randomUUID();
      const filePath = await this.generateDocumentPath(
        userEmail, 
        documentData.template, 
        documentData.title,
        documentData.format || 'docx'
      );
      
      // Save file to storage
      await fs.writeFile(filePath, fileBuffer);
      
      // Calculate file size
      const stats = await fs.stat(filePath);
      const fileSize = stats.size;
      
      // Store document metadata in database
      const [result] = await connection.execute(
        `INSERT INTO documents (
          id, user_id, title, template_type, file_path, content_preview,
          original_sections, parsed_sections, metadata, file_size, file_format,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          documentId,
          documentData.userId,
          documentData.title,
          documentData.template,
          filePath,
          documentData.contentPreview || '',
          JSON.stringify(documentData.originalSections || {}),
          JSON.stringify(documentData.parsedSections || {}),
          JSON.stringify({
            generatedAt: new Date().toISOString(),
            version: 1,
            aiModel: documentData.aiModel || 'gpt-4'
          }),
          fileSize,
          documentData.format || 'docx'
        ]
      );

      // Log the generation for analytics
      await this.logDocumentGeneration(connection, {
        userId: documentData.userId,
        documentId: documentId,
        templateType: documentData.template,
        inputData: documentData.originalSections,
        generatedContent: documentData.contentPreview,
        success: true
      });

      return {
        id: documentId,
        filePath: filePath,
        fileSize: fileSize,
        created: true
      };

    } catch (error) {
      console.error('Error saving document:', error);
      throw new Error(`Failed to save document: ${error.message}`);
    } finally {
      await connection.end();
    }
  }

  // Get user's documents
  async getUserDocuments(userId, options = {}) {
    const connection = await mysql.createConnection(dbConfig);
    
    try {
      const {
        page = 1,
        limit = 20,
        search = '',
        templateType = '',
        sortBy = 'created_at',
        sortOrder = 'DESC',
        favorites = false,
        archived = false
      } = options;

      const offset = (page - 1) * limit;
      
      let whereClause = 'WHERE d.user_id = ? AND d.is_archived = ?';
      let queryParams = [userId, archived];
      
      if (search) {
        whereClause += ' AND (d.title LIKE ? OR d.content_preview LIKE ?)';
        queryParams.push(`%${search}%`, `%${search}%`);
      }
      
      if (templateType) {
        whereClause += ' AND d.template_type = ?';
        queryParams.push(templateType);
      }
      
      if (favorites) {
        whereClause += ' AND d.is_favorite = TRUE';
      }

      const query = `
        SELECT 
          d.*,
          GROUP_CONCAT(dt.tag_name) as tags
        FROM documents d
        LEFT JOIN document_tags dt ON d.id = dt.document_id
        ${whereClause}
        GROUP BY d.id
        ORDER BY d.${sortBy} ${sortOrder}
        LIMIT ? OFFSET ?
      `;
      
      queryParams.push(limit, offset);
      
      const [documents] = await connection.execute(query, queryParams);
      
      // Get total count
      const countQuery = `
        SELECT COUNT(DISTINCT d.id) as total
        FROM documents d
        ${whereClause}
      `;
      
      const [countResult] = await connection.execute(
        countQuery, 
        queryParams.slice(0, -2) // Remove limit and offset
      );
      
      return {
        documents: documents.map(doc => ({
          ...doc,
          tags: doc.tags ? doc.tags.split(',') : [],
          original_sections: JSON.parse(doc.original_sections || '{}'),
          parsed_sections: JSON.parse(doc.parsed_sections || '{}'),
          metadata: JSON.parse(doc.metadata || '{}')
        })),
        total: countResult[0].total,
        page,
        limit,
        totalPages: Math.ceil(countResult[0].total / limit)
      };

    } catch (error) {
      console.error('Error getting user documents:', error);
      throw new Error(`Failed to retrieve documents: ${error.message}`);
    } finally {
      await connection.end();
    }
  }

  // Get specific document
  async getDocument(documentId, userId) {
    const connection = await mysql.createConnection(dbConfig);
    
    try {
      const [documents] = await connection.execute(
        `SELECT d.*, GROUP_CONCAT(dt.tag_name) as tags
         FROM documents d
         LEFT JOIN document_tags dt ON d.id = dt.document_id
         WHERE d.id = ? AND d.user_id = ?
         GROUP BY d.id`,
        [documentId, userId]
      );

      if (documents.length === 0) {
        throw new Error('Document not found');
      }

      const document = documents[0];
      return {
        ...document,
        tags: document.tags ? document.tags.split(',') : [],
        original_sections: JSON.parse(document.original_sections || '{}'),
        parsed_sections: JSON.parse(document.parsed_sections || '{}'),
        metadata: JSON.parse(document.metadata || '{}')
      };

    } catch (error) {
      console.error('Error getting document:', error);
      throw error;
    } finally {
      await connection.end();
    }
  }

  // Delete document
  async deleteDocument(documentId, userId) {
    const connection = await mysql.createConnection(dbConfig);
    
    try {
      // Get document info first
      const document = await this.getDocument(documentId, userId);
      
      // Delete file from storage
      try {
        await fs.unlink(document.file_path);
      } catch (fileError) {
        console.warn('File not found in storage:', fileError.message);
      }
      
      // Delete from database
      await connection.execute(
        'DELETE FROM documents WHERE id = ? AND user_id = ?',
        [documentId, userId]
      );

      return { success: true, message: 'Document deleted successfully' };

    } catch (error) {
      console.error('Error deleting document:', error);
      throw error;
    } finally {
      await connection.end();
    }
  }

  // Update document metadata
  async updateDocument(documentId, userId, updates) {
    const connection = await mysql.createConnection(dbConfig);
    
    try {
      const allowedUpdates = ['title', 'is_favorite', 'is_archived'];
      const updateFields = [];
      const updateValues = [];
      
      for (const [key, value] of Object.entries(updates)) {
        if (allowedUpdates.includes(key)) {
          updateFields.push(`${key} = ?`);
          updateValues.push(value);
        }
      }
      
      if (updateFields.length === 0) {
        throw new Error('No valid updates provided');
      }
      
      updateFields.push('updated_at = NOW()');
      updateValues.push(documentId, userId);
      
      const query = `
        UPDATE documents 
        SET ${updateFields.join(', ')}
        WHERE id = ? AND user_id = ?
      `;
      
      await connection.execute(query, updateValues);
      
      return await this.getDocument(documentId, userId);

    } catch (error) {
      console.error('Error updating document:', error);
      throw error;
    } finally {
      await connection.end();
    }
  }

  // Add tags to document
  async addDocumentTags(documentId, userId, tags) {
    const connection = await mysql.createConnection(dbConfig);
    
    try {
      // Verify document ownership
      await this.getDocument(documentId, userId);
      
      // Remove existing tags
      await connection.execute(
        'DELETE FROM document_tags WHERE document_id = ?',
        [documentId]
      );
      
      // Add new tags
      if (tags && tags.length > 0) {
        const tagValues = tags.map(tag => [crypto.randomUUID(), documentId, tag.trim()]);
        await connection.execute(
          'INSERT INTO document_tags (id, document_id, tag_name) VALUES ' +
          tagValues.map(() => '(?, ?, ?)').join(', '),
          tagValues.flat()
        );
      }
      
      return { success: true, tags };

    } catch (error) {
      console.error('Error adding document tags:', error);
      throw error;
    } finally {
      await connection.end();
    }
  }

  // Log document generation for analytics
  async logDocumentGeneration(connection, logData) {
    try {
      await connection.execute(
        `INSERT INTO ai_generation_logs (
          id, user_id, document_id, template_type, input_data,
          generated_content, success, model_used, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          crypto.randomUUID(),
          logData.userId,
          logData.documentId,
          logData.templateType,
          JSON.stringify(logData.inputData || {}),
          logData.generatedContent || '',
          logData.success,
          logData.modelUsed || 'azure-gpt-4'
        ]
      );
    } catch (error) {
      console.error('Error logging generation:', error);
    }
  }

  // Get user analytics
  async getUserAnalytics(userId, days = 30) {
    const connection = await mysql.createConnection(dbConfig);
    
    try {
      const [analytics] = await connection.execute(`
        SELECT 
          DATE(created_at) as date,
          template_type,
          COUNT(*) as count,
          AVG(generation_time_ms) as avg_generation_time
        FROM ai_generation_logs 
        WHERE user_id = ? 
          AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
          AND success = TRUE
        GROUP BY DATE(created_at), template_type
        ORDER BY date DESC
      `, [userId, days]);

      // Get summary stats
      const [summaryStats] = await connection.execute(`
        SELECT 
          COUNT(DISTINCT d.id) as total_documents,
          COUNT(DISTINCT d.template_type) as templates_used,
          SUM(d.file_size) as total_storage_bytes,
          AVG(agl.generation_time_ms) as avg_generation_time,
          COUNT(CASE WHEN d.is_favorite = TRUE THEN 1 END) as favorite_documents
        FROM documents d
        LEFT JOIN ai_generation_logs agl ON d.id = agl.document_id
        WHERE d.user_id = ?
      `, [userId]);

      return {
        dailyActivity: analytics,
        summary: summaryStats[0] || {}
      };

    } catch (error) {
      console.error('Error getting user analytics:', error);
      throw error;
    } finally {
      await connection.end();
    }
  }
}

module.exports = new DocumentStorageService();