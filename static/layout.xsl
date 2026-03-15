<?xml version="1.0" encoding="UTF-8" ?>
<xsl:stylesheet
  version="1.0"
  xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:atom="http://www.w3.org/2005/Atom"
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
          <ul class="podcasts">
            <xsl:for-each select="body/outline">
              <li class="podcast">
                <xsl:if test="@imageUrl">
                  <img class="podcast__cover" src="{@imageUrl}" alt="" />
                </xsl:if>
                <div class="podcast__body">
                  <a class="podcast__title" href="{@xmlUrl}"><xsl:value-of select="@title" /></a>
                  <xsl:if test="@author">
                    <small class="podcast__author"><xsl:value-of select="@author" /></small>
                  </xsl:if>
                  <xsl:if test="@description">
                    <p class="podcast__desc"><xsl:value-of select="@description" /></p>
                  </xsl:if>
                  <div data-subscribe="" data-href="{@xmlUrl}" />
                </div>
              </li>
            </xsl:for-each>
          </ul>
        </main>
        <script src="/static/subscribe.js" />
        <script src="/static/nav.js" />
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
          <header class="feed-header">
            <xsl:if test="channel/itunes:image">
              <img class="feed-header__cover" src="{channel/itunes:image/@href}" alt="" />
            </xsl:if>
            <hgroup class="feed-header__info">
              <h1 class="feed-header__title"><xsl:value-of select="channel/title" /></h1>
              <xsl:if test="channel/itunes:author">
                <p class="feed-header__author"><xsl:value-of select="channel/itunes:author" /></p>
              </xsl:if>
              <xsl:if test="channel/description">
                <p class="feed-header__desc"><xsl:value-of select="channel/description" /></p>
              </xsl:if>
              <div data-subscribe="" data-href="" />
            </hgroup>
          </header>
          <ol class="episodes">
            <xsl:for-each select="channel/item">
              <li class="episode">
                <a class="episode__title" href="{enclosure/@url}"><xsl:value-of select="title" /></a>
                <xsl:if test="itunes:duration">
                  <small class="episode__duration">
                    <xsl:call-template name="format-duration">
                      <xsl:with-param name="seconds" select="itunes:duration" />
                    </xsl:call-template>
                  </small>
                </xsl:if>
              </li>
            </xsl:for-each>
          </ol>
        </main>
        <script src="/static/subscribe.js" />
        <script src="/static/nav.js" />
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
