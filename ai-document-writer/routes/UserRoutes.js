// backend/routes/userRoutes.js
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const documentStorage = require('../services/documentStorage');
const path = require('path');
const fs = require('fs').promises;

// Get user profile
router.post('/auth/profile', authenticateToken, async (req, res) => {
  try {
    res.json({
      success: true,
      user: req.user,
      message: 'User profile retrieved successfully'
    });
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({ error: 'Failed to get user profile' });
  }
});

// Get user documents
router.get('/user/documents', authenticateToken, async (req, res) => {
  try {
    const options = {
      page: parseInt(req.query.page) || 1,
      limit: parseInt(req.query.limit) || 20,
      search: req.query.search || '',
      templateType: req.query.templateType || '',
      sortBy: req.query.sortBy || 'created_at',
      sortOrder: req.query.sortOrder || 'DESC',
      favorites: req.query.favorites === 'true',
      archived: req.query.archived === 'true'
    };

    const result = await documentStorage.getUserDocuments(req.user.id, options);
    res.json(result);

  } catch (error) {
    console.error('Error getting user documents:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get specific document
router.get('/user/documents/:id', authenticateToken, async (req, res) => {
  try {
    const document = await documentStorage.getDocument(req.params.id, req.user.id);
    res.json(document);
  } catch (error) {
    console.error('Error getting document:', error);
    res.status(error.message === 'Document not found' ? 404 : 500)
       .json({ error: error.message });
  }
});

// Update document
router.put('/user/documents/:id', authenticateToken, async (req, res) => {
  try {
    const updates = req.body;
    const document = await documentStorage.updateDocument(req.params.id, req.user.id, updates);
    res.json(document);
  } catch (error) {
    console.error('Error updating document:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete document
router.delete('/user/documents/:id', authenticateToken, async (req, res) => {
  try {
    const result = await documentStorage.deleteDocument(req.params.id, req.user.id);
    res.json(result);
  } catch (error) {
    console.error('Error deleting document:', error);
    res.status(500).json({ error: error.message });
  }
});

// Download stored document
router.get('/user/documents/:id/download', authenticateToken, async (req, res) => {
  try {
    const document = await documentStorage.getDocument(req.params.id, req.user.id);
    
    // Check if file exists
    try {
      await fs.access(document.file_path);
    } catch (error) {
      return res.status(404).json({ error: 'File not found in storage' });
    }

    // Read and send file
    const fileBuffer = await fs.readFile(document.file_path);
    const filename = path.basename(document.file_path);
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', fileBuffer.length);
    
    res.send(fileBuffer);

  } catch (error) {
    console.error('Error downloading document:', error);
    res.status(500).json({ error: error.message });
  }
});

// Duplicate document
router.post('/user/documents/:id/duplicate', authenticateToken, async (req, res) => {
  try {
    const originalDocument = await documentStorage.getDocument(req.params.id, req.user.id);
    
    // Read original file
    const fileBuffer = await fs.readFile(originalDocument.file_path);
    
    // Create duplicate with new title
    const duplicateData = {
      userId: req.user.id,
      title: `${originalDocument.title} (Copy)`,
      template: originalDocument.template_type,
      originalSections: originalDocument.original_sections,
      parsedSections: originalDocument.parsed_sections,
      contentPreview: originalDocument.content_preview,
      format: originalDocument.file_format
    };

    const result = await documentStorage.saveDocument(req.user.email, duplicateData, fileBuffer);
    res.json({ success: true, documentId: result.id });

  } catch (error) {
    console.error('Error duplicating document:', error);
    res.status(500).json({ error: error.message });
  }
});

// Add/update document tags
router.post('/user/documents/:id/tags', authenticateToken, async (req, res) => {
  try {
    const { tags } = req.body;
    const result = await documentStorage.addDocumentTags(req.params.id, req.user.id, tags);
    res.json(result);
  } catch (error) {
    console.error('Error updating document tags:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get user analytics
router.get('/user/analytics', authenticateToken, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const analytics = await documentStorage.getUserAnalytics(req.user.id, days);
    res.json(analytics);
  } catch (error) {
    console.error('Error getting user analytics:', error);
    res.status(500).json({ error: error.message });
  }
});

// Batch operations
router.post('/user/documents/batch', authenticateToken, async (req, res) => {
  try {
    const { action, documentIds, data = {} } = req.body;
    const results = [];

    for (const documentId of documentIds) {
      try {
        let result;
        switch (action) {
          case 'delete':
            result = await documentStorage.deleteDocument(documentId, req.user.id);
            break;
          case 'favorite':
            result = await documentStorage.updateDocument(documentId, req.user.id, { 
              is_favorite: data.favorite 
            });
            break;
          case 'archive':
            result = await documentStorage.updateDocument(documentId, req.user.id, { 
              is_archived: data.archived 
            });
            break;
          default:
            throw new Error('Invalid batch action');
        }
        results.push({ documentId, success: true, result });
      } catch (error) {
        results.push({ documentId, success: false, error: error.message });
      }
    }

    res.json({ success: true, results });

  } catch (error) {
    console.error('Error performing batch operation:', error);
    res.status(500).json({ error: error.message });
  }
});

// Export documents
router.post('/user/documents/export', authenticateToken, async (req, res) => {
  try {
    const { documentIds, format = 'zip' } = req.body;
    
    if (format === 'zip') {
      const archiver = require('archiver');
      const archive = archiver('zip');
      
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="documents_export_${Date.now()}.zip"`);
      
      archive.pipe(res);
      
      for (const documentId of documentIds) {
        try {
          const document = await documentStorage.getDocument(documentId, req.user.id);
          const fileBuffer = await fs.readFile(document.file_path);
          const filename = `${document.title}.${document.file_format}`;
          archive.append(fileBuffer, { name: filename });
        } catch (error) {
          console.warn(`Skipping document ${documentId}: ${error.message}`);
        }
      }
      
      archive.finalize();
    } else {
      res.status(400).json({ error: 'Unsupported export format' });
    }

  } catch (error) {
    console.error('Error exporting documents:', error);
    res.status(500).json({ error: error.message });
  }
});

// Enhanced document generation with storage
router.post('/api/generate-document', authenticateToken, async (req, res) => {
  try {
    const { template, sections } = req.body;

    // Validation
    if (!template || !sections) {
      return res.status(400).json({ 
        error: 'Missing required fields: template and sections' 
      });
    }

    // Check Azure OpenAI configuration
    const AZURE_OPENAI_CONFIG = {
      endpoint: process.env.AZURE_OPENAI_ENDPOINT,
      apiKey: process.env.AZURE_OPENAI_API_KEY,
      deploymentName: process.env.AZURE_OPENAI_DEPLOYMENT_NAME || 'gpt-4',
      apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-02-15-preview'
    };

    if (!AZURE_OPENAI_CONFIG.endpoint || !AZURE_OPENAI_CONFIG.apiKey) {
      return res.status(500).json({ 
        error: 'Azure OpenAI not configured. Please check environment variables.' 
      });
    }

    // Generate document content (existing logic)
    const templateConfig = DOCUMENT_TEMPLATES[template];
    const systemPrompt = templateConfig.systemPrompt;
    const userPrompt = templateConfig.generatePrompt(sections);
    const generatedContent = await callAzureOpenAI(systemPrompt, userPrompt);
    
    let parsedSections;
    if (template === 'step-by-step-guide') {
      parsedSections = parseStepByStepResponse(generatedContent);
      if (sections.structuredSteps) {
        parsedSections.structuredSteps = sections.structuredSteps;
      }
    } else {
      parsedSections = parseAIResponse(generatedContent);
    }

    // Generate DOCX file
    const templateType = template === 'step-by-step-guide' ? 'step-by-step-guide' : 'standard';
    const docxBuffer = await generateDocxFromTemplate(templateConfig.docxTemplate, parsedSections, templateType);
    
    // Save to storage
    const documentData = {
      userId: req.user.id,
      title: `${templateConfig.name} - ${new Date().toLocaleDateString()}`,
      template: template,
      originalSections: sections,
      parsedSections: parsedSections,
      contentPreview: generatedContent.substring(0, 500),
      format: 'docx'
    };

    const savedDocument = await documentStorage.saveDocument(req.user.email, documentData, docxBuffer);

    res.json({
      success: true,
      document: {
        id: savedDocument.id,
        template: template,
        title: documentData.title,
        content: generatedContent,
        parsedSections: parsedSections,
        generatedAt: new Date().toISOString(),
        originalSections: sections,
        filePath: savedDocument.filePath,
        fileSize: savedDocument.fileSize
      }
    });

  } catch (error) {
    console.error('Document generation error:', error);
    res.status(500).json({ 
      error: 'Failed to generate document',
      details: error.message
    });
  }
});

module.exports = router;