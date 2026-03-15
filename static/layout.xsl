<?xml version="1.0" encoding="UTF-8" ?>
<xsl:stylesheet
  version="1.0"
  xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
>

  <xsl:output method="html" encoding="UTF-8" />

  <!-- OPML: podcast list -->
  <xsl:template match="/opml">
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title><xsl:value-of select="head/title" /></title>
        <link rel="stylesheet" href="/static/style.css" />
        <link rel="icon" type="image/svg+xml" href="/static/favicon/favicon.svg" />
      </head>
      <body>
        <main>
          <h1><xsl:value-of select="head/title" /></h1>
          <ul>
            <xsl:for-each select="body/outline">
              <li>
                <a href="{@xmlUrl}"><xsl:value-of select="@title" /></a>
              </li>
            </xsl:for-each>
          </ul>
        </main>
      </body>
    </html>
  </xsl:template>

  <!-- RSS: podcast episodes -->
  <xsl:template match="/rss">
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title><xsl:value-of select="channel/title" /></title>
        <link rel="stylesheet" href="/static/style.css" />
        <link rel="icon" type="image/svg+xml" href="/static/favicon/favicon.svg" />
      </head>
      <body>
        <nav>
          <a href="/feed.opml">&#8592; Back</a>
        </nav>
        <main>
          <h1><xsl:value-of select="channel/title" /></h1>
          <xsl:if test="channel/itunes:image">
            <img src="{channel/itunes:image/@href}" alt="" />
          </xsl:if>
          <xsl:if test="channel/itunes:author">
            <p><xsl:value-of select="channel/itunes:author" /></p>
          </xsl:if>
          <ol>
            <xsl:for-each select="channel/item">
              <li>
                <a href="{enclosure/@url}"><xsl:value-of select="title" /></a>
                <xsl:if test="itunes:duration">
                  <xsl:text> </xsl:text>
                  <small>
                    <xsl:call-template name="format-duration">
                      <xsl:with-param name="seconds" select="itunes:duration" />
                    </xsl:call-template>
                  </small>
                </xsl:if>
              </li>
            </xsl:for-each>
          </ol>
        </main>
      </body>
    </html>
  </xsl:template>

  <!-- Format seconds as h:mm:ss or m:ss -->
  <xsl:template name="format-duration">
    <xsl:param name="seconds" />
    <xsl:variable name="h" select="floor($seconds div 3600)" />
    <xsl:variable name="m" select="floor(($seconds mod 3600) div 60)" />
    <xsl:variable name="s" select="$seconds mod 60" />
    <xsl:if test="$h > 0">
      <xsl:value-of select="$h" />
      <xsl:text>:</xsl:text>
      <xsl:if test="$m &lt; 10">0</xsl:if>
    </xsl:if>
    <xsl:value-of select="$m" />
    <xsl:text>:</xsl:text>
    <xsl:if test="$s &lt; 10">0</xsl:if>
    <xsl:value-of select="$s" />
  </xsl:template>

</xsl:stylesheet>
